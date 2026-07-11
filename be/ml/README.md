# Teaching the local LLM from your marks

Two learning paths, from lightest to heaviest. Both start from the **"Mark as
correct"** button in the smart-search proof card, which writes to the
`search_feedback` table.

## 1. Works now — feedback-steered reranking (no GPU, no training)

Already wired. When you enable **LLM rerank** in the Devices screen, the backend
pulls your marked-correct examples for that query
(`repositories/feedback.examples_for_query`) and passes them to the LLM as
**few-shot anchors** (`ai/main.py` `/rerank`). The model "learns" the team's
notion of relevance in-context, instantly, every search. Nothing to run.

## 2. Real weight fine-tuning — LoRA adapter (needs a CUDA GPU)

Bakes the preferences into the weights. **Not runnable on the app machine**
(Intel NPU/Arc, no CUDA) — do this on a CUDA GPU or a cloud GPU.

```bash
# a) On the app machine — export the dataset from your marks
python -m be.ml.export_dataset --out be/ml/data
#    -> be/ml/data/sft.jsonl (+ pairs.jsonl)

# b) On a CUDA GPU machine — install + train
pip install torch transformers peft trl datasets accelerate bitsandbytes
python be/ml/train_lora.py --data be/ml/data/sft.jsonl --out be/ml/adapter

# c) Convert the adapter to GGUF (llama.cpp)
python llama.cpp/convert_lora_to_gguf.py be/ml/adapter --outfile be/ml/adapter.gguf

# d) Load it into Ollama on the app machine
cd be/ml && ollama create itledger-qwen -f Modelfile

# e) Point the app at your fine-tuned model
#    set OLLAMA_MODEL=itledger-qwen (ai/run-host.ps1 or the environment)
```

Re-export and re-train whenever you've collected a meaningful batch of new
marks. The more you mark, the better it fits your fleet.

## Files
- `export_dataset.py` — `search_feedback` -> `sft.jsonl` / `pairs.jsonl`
- `train_lora.py` — LoRA SFT of Qwen2.5-7B-Instruct (CUDA-guarded)
- `Modelfile` — loads the GGUF adapter onto `qwen2.5:7b` in Ollama
