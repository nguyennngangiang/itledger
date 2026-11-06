# Bàn giao dữ liệu ITLedger sang hệ thống khác

Tài liệu này đủ để bên nhận viết bộ nhập mà không phải đoán gì. Mọi con số và
kiểu dữ liệu dưới đây lấy từ CSDL đang chạy ngày 06/11/2026, không chép tay.

> Repo này **công khai**. Không bao giờ đặt `EXPORT_TOKEN`, dữ liệu thật hay
> họ tên nhân viên vào đây.

## Hai đường lấy dữ liệu

**1. Qua API** — hệ thống mới tự kéo. Cần người quản trị bật cổng trước
(`EXPORT_TOKEN` + `EXPORT_TOKEN_UNTIL`, xem `be/.env.example`).

```bash
curl -fsS https://<host>/api/export/data/status            # không cần khoá
curl -fsS -H "Authorization: Bearer $EXPORT_TOKEN" \
     https://<host>/api/export/data -o itledger-export.json
```

**2. Qua tệp** — `deploy/vps/dump-db.sh` sinh ra `itledger.dump` (pg_dump -Fc)
và `itledger.sql`, khôi phục bằng `deploy/vps/restore-db.sh`. Dùng đường này
khi hai bên cùng là PostgreSQL và muốn giống hệt từng byte.

Phần còn lại của tài liệu nói về đường 1, vì đó là đường cần mô tả.

## Cổng đóng hay mở

`GET /api/export/data/status` không cần khoá và luôn trả lời:

```json
{"open": true,  "until": "2026-11-09", "reason": null}
{"open": false, "until": null, "reason": "EXPORT_TOKEN chưa đặt"}
```

Cổng **404** chứ không 401 khi đóng hoặc sai khoá — đừng suy ra "sai đường
dẫn" từ 404, hỏi `/status` trước.

## Hình dạng bản xuất

```json
{
  "version": 1,
  "taken_at": "2026-11-06T06:02:11.482930+00:00",
  "order":  ["users", "devices", "handovers", "maintenance",
             "import_issues", "search_feedback", "documents"],
  "counts": {"users": 258, "devices": 356, "handovers": 370,
             "maintenance": 34, "import_issues": 15,
             "search_feedback": 0, "documents": 0},
  "tables": {"users": [ {...}, ... ], "devices": [ ... ], ...}
}
```

`order` là **thứ tự nạp an toàn theo khoá ngoại**, không phải thứ tự ngẫu
nhiên. Đồ thị phụ thuộc:

```
users ──< devices.user_id
users ──< handovers.from_user_id, handovers.to_user_id
devices ──< handovers.device_id
devices ──< maintenance.device_id
import_issues, search_feedback, documents : độc lập
```

## Cột và kiểu

Khoá chính in **đậm**. `ts` = timestamp **không** múi giờ, `tstz` = có múi giờ.

| users | kiểu | | devices | kiểu |
|---|---|---|---|---|
| **employee_code** | text | | **serial_number** | text |
| name | text? | | barcode | text? |
| team | text? | | type, brand, cpu, ram, storage, os, msoffice | text? |
| status | text `active\|retired` | | buy_date | date? |
| deleted_at | ts? | | name | text? |
| | | | user_id | text? → users |
| | | | status | text? `active\|in_stock\|maintaining\|on_del` |
| | | | deleted_at | ts? |

| handovers | kiểu | | maintenance | kiểu |
|---|---|---|---|---|
| **handover_id** | text | | **maintenance_id** | text |
| handover_date | date? | | maintenance_date | date? |
| device_id | text? → devices | | device_id | text? → devices |
| from_user_id | text? → users | | team, part, reason, solution, result, remarks | text? |
| to_user_id | text? → users | | cost_vnd | numeric? → **chuỗi** |
| reason | text? | | deleted_at | ts? |
| deleted_at | ts? | | | |

| import_issues | kiểu | | search_feedback | kiểu | | documents | kiểu |
|---|---|---|---|---|---|---|
| **id** | bigint | | **id** | bigint | | **id** | bigint |
| created_at | ts | | resource | text | | title, filename | text |
| source_file | text? | | item_id | text? | | mime | text? |
| kind | text | | query | text | | uploaded_at | **tstz** |
| resource | text | | document | text? | | char_count | int |
| item_id | text? | | score | float? | | status | text |
| payload | jsonb | | label | smallint | | | |
| status | text | | created_at | ts | | | |
| resolved_at | ts? | | | | | | |
| resolution | jsonb? | | | | | | |

## Bảy điều dễ sai nếu không đọc

1. **`IT-STORE` không phải một con người.** Đó là tài khoản ma sở hữu mọi
   thiết bị không ai dùng (`be/constants.py` `GHOST_CODE`). Nó nằm trong bảng
   `users` như một hàng bình thường — đừng nhập nó vào danh bạ nhân sự, và
   đừng coi `devices.user_id = 'IT-STORE'` là "có chủ".
2. **Hàng đã xoá mềm ĐƯỢC mang theo.** `deleted_at` khác `null` nghĩa là nằm
   trong thùng rác, không phải đang dùng. Mọi báo cáo phải lọc
   `deleted_at IS NULL`; bỏ chúng lại lúc nhập là làm mất lịch sử khôi phục
   được.
3. **`cost_vnd` là CHUỖI, không phải số.** Cố ý: đi qua float là mất chính
   xác âm thầm. Parse thành decimal, đừng parse thành double.
4. **Dấu thời gian trộn hai loại.** `documents.uploaded_at` có múi giờ, mọi
   cột `ts` khác thì không — chuỗi ISO của chúng **không có offset**. Coi
   chúng là giờ UTC; đó là giờ của máy chủ.
5. **Không có vector nhúng.** `document_chunks` cố ý bị bỏ: mỗi hàng là một
   vector 1024 chiều chỉ có nghĩa với đúng mô hình đã sinh ra nó. Nhúng lại
   từ `documents` ở nhà mới.
6. **Đối chiếu `counts` trước khi nhập.** Nếu `len(tables[t]) != counts[t]`
   thì bản xuất hỏng — nhưng máy chủ đã tự kiểm điều đó và trả **503** kèm
   "đổi giữa chừng" khi có người sửa sổ trong lúc xuất. Gặp 503 thì **chờ vài
   giây rồi gọi lại**, đừng nhập bản dở.
7. **Thiết bị có thể trỏ tới nhân sự đã nghỉ** (`users.status='retired'`).
   Hợp lệ, không phải dữ liệu bẩn: máy chưa thu hồi vẫn đứng tên người cũ.

## Trình tự nhập gợi ý

```
1. GET /status  -> open == true
2. GET /data    -> 200, hoặc 503 thì chờ 5 giây gọi lại (tối đa 3 lần)
3. Kiểm: với mọi t, len(tables[t]) == counts[t]
4. Nạp theo đúng `order`
5. Kiểm sau nhập: số hàng khớp counts; mọi devices.user_id, handovers.*_user_id
   đều có trong users; mọi *.device_id đều có trong devices
6. Báo cho bên gửi tắt cổng: xoá EXPORT_TOKEN rồi dựng lại api
```

## Tắt cổng khi xong

Cổng tự hết hạn vào `EXPORT_TOKEN_UNTIL`, nhưng đừng dựa vào đó. Xoá
`EXPORT_TOKEN` khỏi `.env` rồi dựng lại `api` là nó biến mất ngay.
