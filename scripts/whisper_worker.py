#!/usr/bin/env python3
"""One resident Whisper model per job; requests and responses carry IDs."""
import json
import sys
from whisper_runtime import load_model, transcribe


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    try:
        model, runtime = load_model()
        print(json.dumps({'status': 'ready', 'runtime': runtime}), flush=True)
    except Exception as error:
        print(json.dumps({'error': str(error)}), flush=True)
        return 1
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if request.get('command') == 'quit':
                break
            response = transcribe(model, request['file'], request.get('language', 'tr'),
                                  request.get('prompt'), request.get('word_timestamps', False))
            print(json.dumps({**response, 'id': request['id'], '_runtime': runtime}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({'id': request.get('id'), 'error': str(error)}, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
