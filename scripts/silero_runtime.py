"""Packaged Silero model, native sequential 512-sample frames, one load per batch."""
import json
from pathlib import Path
import subprocess


def load_model():
    import torch
    from silero_vad import load_silero_vad
    torch.set_num_threads(1)
    return load_silero_vad()


def profile_audio(file, model):
    import numpy as np
    import torch
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(file),
                              '-vn', '-ar', '16000', '-ac', '1', '-f', 'f32le',
                              '-acodec', 'pcm_f32le', 'pipe:1'],
                             capture_output=True, check=True, timeout=120)
    wav = torch.from_numpy(np.frombuffer(decoded.stdout, dtype='<f4').copy())
    if not len(wav):
        raise ValueError(f'Empty audio: {file}')
    model.reset_states()
    profile = []
    with torch.inference_mode():
        for start in range(0, len(wav), 512):
            frame = wav[start:start + 512]
            if len(frame) < 512:
                frame = torch.nn.functional.pad(frame, (0, 512 - len(frame)))
            profile.append({'time': start / 16000, 'prob': float(model(frame, 16000).item())})
    return {'audio_file': str(file), 'sample_rate': 16000, 'hop': 0.032,
            'duration': len(wav) / 16000, 'profile': profile}


def save_json(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.with_suffix('.tmp.json')
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temp.replace(file)
