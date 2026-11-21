

# ---- フェーズ94: x11grab+NVENCの代わりにNvFBC→CUDA→NVENC(scripts/94_nvfbc/nvfbc_rec.c)で映像を録る ----
_NVFBC_REC = "/verify/94_nvfbc/nvfbc_rec"
_NVFBC_ARGS = []  # sampling_ms, push|timer, nv12|bgra(variantごとに下の行を書き換える)


def build_video_ffmpeg_cmd(config, x, y, w, h, video_output, side_stream_path=None, *,  # noqa: F811
                           time_scale=1.0, gpu_encode=False, window_id=None):
    if window_id or not gpu_encode:
        raise RuntimeError("nvfbc_rec は座標指定+GPUエンコードのみ対応")
    return [_NVFBC_REC, config.display, str(x), str(y), str(w), str(h), video_output, side_stream_path or "-", *_NVFBC_ARGS]
