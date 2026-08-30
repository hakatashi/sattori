"""画面キャプチャと画素比較。"""

import numpy as np
import pytest
from PIL import Image

from recording import vision


def test_mad_zero_for_identical_frames():
    a = np.zeros((4, 4), dtype=np.float32)
    assert vision.mad(a, a) == 0.0


def test_mad_computes_mean_absolute_difference():
    a = np.array([[0.0, 0.0], [0.0, 0.0]], dtype=np.float32)
    b = np.array([[2.0, 4.0], [0.0, 2.0]], dtype=np.float32)
    assert vision.mad(a, b) == pytest.approx(2.0)


def test_build_still_mask_returns_none_when_rect_is_none():
    assert vision.build_still_mask(None, 640, 480) is None


def test_build_still_mask_excludes_rect_scaled_to_160x120(tmp_path):
    # th11のPause Menu画面選択カーソル明滅矩形(元のウィンドウ座標系(70,288)-(188,318)、
    # touhou-recorder reports/37・38)を640x480ウィンドウで変換すると、160x120座標系では
    # おおよそx=[17,47) y=[72,80)になる。
    mask = vision.build_still_mask((70, 288, 188, 318), 640, 480)

    assert mask.shape == (120, 160)
    assert mask[75, 30] == False  # noqa: E712 - 矩形内は除外(False)
    assert mask[0, 0] == True  # noqa: E712 - 矩形外は静止判定に使う(True)


def test_mad_masked_falls_back_to_mad_when_mask_is_none():
    a = np.array([[0.0, 0.0], [0.0, 0.0]], dtype=np.float32)
    b = np.array([[2.0, 4.0], [0.0, 2.0]], dtype=np.float32)

    assert vision.mad_masked(a, b, None) == pytest.approx(vision.mad(a, b))


def test_mad_masked_ignores_differences_inside_excluded_mask():
    a = np.zeros((4, 4), dtype=np.float32)
    b = np.zeros((4, 4), dtype=np.float32)
    b[0, 0] = 100.0  # マスクで除外される画素だけが変化(=明滅カーソル相当)
    mask = np.ones((4, 4), dtype=bool)
    mask[0, 0] = False

    assert vision.mad_masked(a, b, mask) == pytest.approx(0.0)


def test_load_end_template_returns_none_when_path_is_none():
    assert vision.load_end_template(None) is None


def test_load_end_template_returns_none_when_file_missing(tmp_path):
    assert vision.load_end_template(str(tmp_path / "missing.png")) is None


def test_load_end_template_returns_full_downsampled_frame(tmp_path):
    # grab_frame()と同じ160x120グレースケールへダウンサンプルしたフル画像を返す
    # (切り出しはbuild_end_template_maskの責務、reports/33・56)。
    path = tmp_path / "template.png"
    Image.new("RGB", (640, 480), color=(100, 150, 200)).save(path)

    template = vision.load_end_template(str(path))

    assert template.shape == (120, 160)


def test_build_end_template_mask_defaults_to_top_band():
    # rect未指定なら従来通り「上部END_TEMPLATE_ROWS行×全幅」(th06/07/08)。
    mask = vision.build_end_template_mask(None, 640, 480)

    assert mask.shape == (120, 160)
    assert mask[: vision.END_TEMPLATE_ROWS, :].all()
    assert not mask[vision.END_TEMPLATE_ROWS :, :].any()


def test_build_end_template_mask_restricts_to_custom_rect():
    # th10はリプレイ内容に依存しない左上の"REPLAY"見出し部分だけに絞り込む
    # (touhou-recorder reports/56)。
    mask = vision.build_end_template_mask((0, 0, 244, 76), 640, 480)

    assert mask[:19, :61].all()
    assert not mask[19:, :].any()
    assert not mask[:, 61:].any()


def test_masked_end_template_comparison_is_content_independent_of_lower_region(tmp_path):
    # フェーズ34: 上部の帯(タイトル文言+列見出し)はリプレイ一覧の中身
    # (プレイヤー名・日付等、画像下部)に依存しないことを確認する。
    img_a = Image.new("RGB", (640, 480), color=(255, 255, 255))
    for y in range(400, 480):
        for x in range(0, 640, 10):
            img_a.putpixel((x, y), (0, 0, 0))
    path_a = tmp_path / "a.png"
    img_a.save(path_a)

    img_b = Image.new("RGB", (640, 480), color=(255, 255, 255))
    path_b = tmp_path / "b.png"
    img_b.save(path_b)

    template_a = vision.load_end_template(str(path_a))
    template_b = vision.load_end_template(str(path_b))
    mask = vision.build_end_template_mask(None, 640, 480)

    assert vision.mad_masked(template_a, template_b, mask) == pytest.approx(0.0)


def test_build_still_mask_accepts_multiple_rects():
    """th20はリプレイ終了後に2箇所でアニメーションが継続する(reports/45)。"""
    mask = vision.build_still_mask(
        [(0, 0, 320, 240), (960, 720, 1280, 960)], 1280, 960
    )

    assert mask[10, 10] == False  # noqa: E712 - 1つ目の矩形内
    assert mask[110, 150] == False  # noqa: E712 - 2つ目の矩形内
    assert mask[60, 80] == True  # noqa: E712 - どちらの矩形にも入らない


def test_build_still_mask_still_accepts_a_single_rect_tuple():
    """既存タイトル(th11)の単一矩形指定は従来どおり動く。"""
    mask = vision.build_still_mask((70, 288, 188, 318), 640, 480)

    assert mask[75, 30] == False  # noqa: E712
    assert mask[0, 0] == True  # noqa: E712
