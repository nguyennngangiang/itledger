"""Cổng di cư tạm thời: chốt chặn phải FAIL-CLOSED ở mọi nhánh.

Đây là phần duy nhất đáng viết test thuần. Nội dung bản xuất thì cần CSDL, còn
chỗ này là logic quyết định "mở hay đóng" — và nó là lớp bảo vệ DUY NHẤT của
258 hồ sơ nhân sự, trên một ứng dụng đã bỏ đăng nhập và đang mở ra Internet.
Mỗi nhánh dưới đây là một cách quên cấu hình, và cách nào cũng phải ra ĐÓNG.
"""
from datetime import date, timedelta

import pytest

from be import config
from be.routers import export as mod

GOOD = "k" * 40


@pytest.fixture
def cong(monkeypatch):
    """Đặt token/hạn rồi trả hàm hỏi 'cổng đang đóng vì lý do gì'."""
    def dat(token=GOOD, until="2030-01-01"):
        monkeypatch.setattr(config.settings, "export_token", token)
        monkeypatch.setattr(config.settings, "export_token_until", until)
        return mod._export_open()
    return dat


def test_chua_cau_hinh_la_dong(cong):
    """Mặc định của một máy chưa ai đụng tới phải là đóng."""
    assert cong(token="") is not None
    assert cong(until="") is not None


def test_token_ngan_bi_tu_choi(cong):
    """Khoá ngắn là khoá đoán được. 31 ký tự vẫn chưa đủ."""
    assert cong(token="k" * 31) is not None
    assert cong(token="k" * 32) is None


def test_han_phai_la_ngay_that(cong):
    assert cong(until="hom-nay") is not None
    assert cong(until="2030-13-45") is not None


def test_qua_han_thi_tu_dong_dong(cong):
    hom_qua = (date.today() - timedelta(days=1)).isoformat()
    assert cong(until=hom_qua) is not None
    # Đúng ngày hết hạn thì VẪN mở — hạn là ngày cuối còn dùng được, không
    # phải ngày đầu bị chặn.
    assert cong(until=date.today().isoformat()) is None


def test_du_dieu_kien_thi_mo(cong):
    assert cong() is None


def test_ly_do_dong_khong_lo_khoa(cong):
    """Thông điệp lý do đi vào /export/data/status, vốn KHÔNG cần khoá."""
    for ly_do in (cong(token=""), cong(token="k" * 10), cong(until="")):
        assert ly_do and GOOD not in ly_do and "k" * 10 not in ly_do
