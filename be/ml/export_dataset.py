"""Export marked search feedback -> a LoRA fine-tuning dataset.

Turns the `search_feedback` table (every "mark as correct" the user clicked in
the smart-search proof card) into training files the LoRA trainer consumes:

  - sft.jsonl    supervised chat examples that teach the judge/rerank behavior
  - pairs.jsonl  DPO preference pairs (chosen = marked-correct device,
                 rejected = a different device), for preference tuning

Run (same env as the app, needs DATABASE_URL):
    python -m be.ml.export_dataset --out be/ml/data

This is the "trained on your data" bridge: mark results in the UI -> export ->
train_lora.py on a CUDA GPU -> load the adapter into Ollama.
"""
import argparse
import asyncio
import json
import random
from pathlib import Path

import asyncpg

from ..config import settings

SYSTEM = (
    "You rank IT-device search results by relevance to the query. "
    "Decide whether a device is a strong match and briefly say why."
)


def _sft_example(query: str, document: str) -> dict:
    """One supervised chat sample: teach 'this device is a strong match'."""
    return {
        "messages": [
            {"role": "system", "content": SYSTEM},
            {
                "role": "user",
                "content": (
                    f'Query: "{query}"\nDevice: {document}\n'
                    "Is this a strong match? Answer yes/no with a one-line reason."
                ),
            },
            {
                "role": "assistant",
                "content": f'Yes — it matches "{query}". Evidence: {document}.',
            },
        ]
    }


async def _fetch(pool: asyncpg.Pool) -> list[dict]:
    rows = await pool.fetch(
        "SELECT query, device_id, document FROM search_feedback "
        "WHERE label = 1 AND document IS NOT NULL"
    )
    return [dict(r) for r in rows]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="be/ml/data", help="output directory")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    pool = await asyncpg.create_pool(dsn=settings.database_url)
    try:
        rows = await _fetch(pool)
    finally:
        await pool.close()

    if not rows:
        print("No feedback yet — mark some smart-search results as correct first.")
        return

    docs = list({r["document"] for r in rows})
    sft_path, pairs_path = out / "sft.jsonl", out / "pairs.jsonl"
    with sft_path.open("w", encoding="utf-8") as fs, pairs_path.open(
        "w", encoding="utf-8"
    ) as fp:
        for r in rows:
            fs.write(json.dumps(_sft_example(r["query"], r["document"])) + "\n")
            negatives = [d for d in docs if d != r["document"]]
            if negatives:
                fp.write(
                    json.dumps(
                        {
                            "prompt": f'Query: "{r["query"]}" — which device matches best?',
                            "chosen": r["document"],
                            "rejected": random.choice(negatives),
                        }
                    )
                    + "\n"
                )

    print(f"Wrote {sft_path} and {pairs_path} from {len(rows)} positive marks.")
    print("Next: python be/ml/train_lora.py --data", sft_path, "(needs a CUDA GPU)")


if __name__ == "__main__":
    asyncio.run(main())
