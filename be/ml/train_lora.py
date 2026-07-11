"""LoRA fine-tune Qwen2.5-7B-Instruct on your marked search feedback.

  >>> This does NOT run on the app machine (no CUDA GPU / Intel NPU). <<<
  Run it on a CUDA GPU box (or a cloud GPU). It produces a small LoRA adapter
  you then load into Ollama so the local model reflects your marks.

Pipeline
--------
1. On the app machine, capture marks in the UI, then export:
       python -m be.ml.export_dataset --out be/ml/data
   (copy be/ml/data/sft.jsonl to the GPU machine)

2. On the GPU machine:
       pip install torch transformers peft trl datasets accelerate bitsandbytes
       python be/ml/train_lora.py --data be/ml/data/sft.jsonl --out be/ml/adapter

3. Merge + convert to GGUF and load into Ollama — see be/ml/README.md.

The script guards on CUDA and fails fast with guidance if run somewhere it
can't train, so it's safe to invoke by mistake.
"""
import argparse

BASE_MODEL = "Qwen/Qwen2.5-7B-Instruct"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="sft.jsonl from export_dataset")
    ap.add_argument("--out", default="be/ml/adapter", help="adapter output dir")
    ap.add_argument("--base", default=BASE_MODEL)
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    args = ap.parse_args()

    try:
        import torch
        from datasets import load_dataset
        from peft import LoraConfig
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
        from trl import SFTConfig, SFTTrainer
    except ImportError as e:
        raise SystemExit(
            f"Missing training deps ({e}). On a CUDA GPU machine run:\n"
            "  pip install torch transformers peft trl datasets accelerate bitsandbytes"
        )

    if not torch.cuda.is_available():
        raise SystemExit(
            "No CUDA GPU detected. LoRA fine-tuning a 7B model needs one "
            "(this app box has an Intel NPU/Arc, which this script can't use). "
            "Run on a CUDA GPU or a cloud GPU instance."
        )

    tok = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
        ),
        device_map="auto",
    )

    dataset = load_dataset("json", data_files=args.data, split="train")
    lora = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
    )
    trainer = SFTTrainer(
        model=model,
        processing_class=tok,
        train_dataset=dataset,
        peft_config=lora,
        args=SFTConfig(
            output_dir=args.out,
            num_train_epochs=args.epochs,
            per_device_train_batch_size=1,
            gradient_accumulation_steps=8,
            learning_rate=args.lr,
            bf16=True,
            logging_steps=5,
            save_strategy="epoch",
        ),
    )
    trainer.train()
    trainer.save_model(args.out)
    print(f"Saved LoRA adapter to {args.out}. Next: convert to GGUF (see README.md).")


if __name__ == "__main__":
    main()
