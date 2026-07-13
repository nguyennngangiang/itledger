"""Bilingual enrichment for semantic-search documents.

The inventory data is stored in English ("Display", "Battery", "Low RAM"...),
but the IT team searches in Vietnamese. The small multilingual embedder is weak
at cross-lingual matching on short domain text, so we append Vietnamese synonyms
for any recognised English IT term to each flattened document. The document then
carries BOTH languages — a Vietnamese query matches it same-language (and the
lexical overlap fires too). Only this app's controlled IT vocabulary is mapped.
"""
import re

# English term (as it appears in the data) -> Vietnamese words to append.
_GLOSSARY: dict[str, str] = {
    "display": "màn hình",
    "screen": "màn hình",
    "monitor": "màn hình",
    "battery": "pin",
    "ram": "bộ nhớ ram",
    "memory": "bộ nhớ ram",
    "ssd": "ổ cứng lưu trữ",
    "hdd": "ổ cứng lưu trữ",
    "storage": "ổ cứng dung lượng lưu trữ",
    "disk": "ổ đĩa ổ cứng",
    "ink": "mực in",
    "toner": "mực in",
    "keyboard": "bàn phím",
    "mouse": "chuột",
    "charger": "sạc bộ sạc",
    "adapter": "sạc bộ sạc adapter",
    "fan": "quạt tản nhiệt",
    "cpu": "vi xử lý",
    "processor": "vi xử lý",
    "motherboard": "bo mạch chủ",
    "mainboard": "bo mạch chủ",
    "laptop": "máy tính xách tay laptop",
    "desktop": "máy tính để bàn",
    "printer": "máy in",
    "broken": "hỏng hư lỗi",
    "malfunction": "hỏng hư lỗi trục trặc",
    "malfunctioned": "hỏng hư lỗi trục trặc",
    "damaged": "hư hỏng",
    "dead": "chết hỏng",
    "fault": "lỗi hỏng",
    "error": "lỗi",
    "degradation": "chai suy giảm",
    "degraded": "chai suy giảm",
    "repair": "sửa chữa bảo trì",
    "repaired": "sửa chữa bảo trì",
    "fix": "sửa chữa",
    "service": "bảo trì bảo dưỡng",
    "replace": "thay thế",
    "replacement": "thay thế",
    "add": "thêm nâng cấp",
    "upgrade": "nâng cấp",
    "old": "cũ lâu năm",
    "aging": "cũ lâu năm",
    "new": "mới",
    "slow": "chậm",
    "overheat": "nóng quá nhiệt",
    "overheating": "nóng quá nhiệt",
    "low": "thấp yếu thiếu",
    "capacity": "dung lượng",
    "maintaining": "đang bảo trì sửa chữa",
    "in stock": "trong kho chưa cấp phát",
    "unassigned": "chưa cấp phát trong kho",
    "handover": "bàn giao",
    "return": "trả lại thu hồi",
    "returned": "trả lại thu hồi",
    "resignation": "nghỉ việc thôi việc",
    "resign": "nghỉ việc thôi việc",
    "team": "phòng ban nhóm",
    "owned": "chủ sở hữu người dùng",
    "owner": "chủ sở hữu người dùng",
}

_PATTERNS = [
    (re.compile(rf"\b{re.escape(en)}\b", re.IGNORECASE), vi)
    for en, vi in _GLOSSARY.items()
]


def bilingualize(text: str) -> str:
    """Append Vietnamese synonyms for every recognised English IT term in `text`,
    so a Vietnamese query can match the (English) document same-language."""
    extra = [vi for pat, vi in _PATTERNS if pat.search(text)]
    if not extra:
        return text
    return text + " | " + " ".join(dict.fromkeys(extra))
