"""Shared local inference configuration for batch and one-file entry points."""
import os
import sys
import time


def resource_limits():
    cores = os.cpu_count() or 2
    threads = int(os.environ.get('WHISPER_CPU_THREADS', '2'))
    workers = int(os.environ.get('WHISPER_WORKERS', '1'))
    return {'cpu_threads': max(1, min(threads or max(1, cores - 1), cores)),
            'num_workers': max(1, min(workers, 2)), 'total_cpus': cores}


def load_model(model_size=None, device=None, compute_type=None):
    from faster_whisper import WhisperModel
    limits = resource_limits()
    name = model_size or os.environ.get('WHISPER_MODEL', 'large-v3')
    device = device or os.environ.get('WHISPER_DEVICE', 'cpu')
    precision = compute_type or os.environ.get('WHISPER_COMPUTE_TYPE', 'int8')
    if device == 'cpu' and precision == 'float16':
        precision = 'int8'
    started = time.monotonic()
    fallback = None
    try:
        model = WhisperModel(name, device=device, compute_type=precision,
                             cpu_threads=limits['cpu_threads'], num_workers=limits['num_workers'])
    except Exception as error:
        if device != 'cuda' or not any(s in str(error).lower() for s in ('cuda', 'cublas', 'cudnn', 'out of memory')):
            raise
        fallback = str(error)
        print('CUDA unavailable; falling back to bounded CPU/int8 inference.', file=sys.stderr, flush=True)
        device, precision = 'cpu', 'int8'
        model = WhisperModel(name, device=device, compute_type=precision,
                             cpu_threads=limits['cpu_threads'], num_workers=limits['num_workers'])
    runtime = {**limits, 'model': name, 'device': device, 'compute_type': precision,
               'load_time_s': round(time.monotonic() - started, 2), 'fallback': fallback}
    return model, runtime


def transcribe(model, audio_file, language='tr', prompt=None, word_timestamps=False):
    if not os.path.isfile(audio_file):
        raise ValueError('Audio file does not exist')
    started = time.monotonic()
    segments_iter, info = model.transcribe(
        audio_file, language=None if language == 'auto' else language, task='transcribe',
        beam_size=5, best_of=5, patience=1.0, length_penalty=1.0,
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0], compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0, no_speech_threshold=0.6, condition_on_previous_text=True,
        word_timestamps=word_timestamps, vad_filter=True,
        vad_parameters={'min_silence_duration_ms': 500, 'speech_pad_ms': 200},
        initial_prompt=prompt[:500] if prompt else None)
    segments = []
    for seg in segments_iter:
        entry = {'id': seg.id, 'text': seg.text.strip(), 'start': seg.start, 'end': seg.end,
                 'seek': int(seg.seek), 'no_speech_prob': seg.no_speech_prob,
                 'avg_logprob': seg.avg_logprob, 'compression_ratio': seg.compression_ratio,
                 'temperature': seg.temperature, 'language': info.language}
        if seg.words:
            entry['words'] = [{'word': w.word, 'start': w.start, 'end': w.end,
                               'probability': w.probability} for w in seg.words]
        segments.append(entry)
    elapsed = time.monotonic() - started
    return {'text': ' '.join(s['text'] for s in segments), 'segments': segments,
            'language': info.language, 'duration': info.duration,
            '_stats': {'transcribe_time_s': round(elapsed, 2),
                       'realtime_factor': round(info.duration / elapsed, 2) if elapsed else 0,
                       'segment_count': len(segments)}}
