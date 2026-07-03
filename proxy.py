#!/usr/bin/env python3
"""手提行李计算工具 — 本地代理（Groq）"""

import io
import sys
# Force UTF-8 output on Windows consoles
if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import urllib.request
import urllib.error
import json
import re
import os
import threading

# Vision-capable model only for requests that actually contain an image — it's
# a small 17B model that proved unreliable at multi-step reasoning (zone
# lookups, compound arithmetic). Text-only requests get a larger text model.
GROQ_MODEL_VISION = "meta-llama/llama-4-scout-17b-16e-instruct"
GROQ_MODEL_TEXT   = "llama-3.3-70b-versatile"
GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
PORT     = 8765
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, anthropic-version',
    'Access-Control-Max-Age':       '86400',
}

_req_count = 0
_lock = threading.Lock()

def next_req_id():
    global _req_count
    with _lock:
        _req_count += 1
        return _req_count


def load_api_key():
    config_path = os.path.join(BASE_DIR, 'config.json')
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        key = cfg.get('api_key', '').strip()
        if not key or key == 'YOUR_API_KEY_HERE':
            print('\n  [错误] config.json 中未填入有效的 Groq API Key。')
            print('  请前往 https://console.groq.com/keys 获取 Key，')
            print('  填入 config.json 的 api_key 字段后重新启动。\n')
            return None
        return key
    except FileNotFoundError:
        print('\n  [错误] 未找到 config.json。\n')
        return None
    except json.JSONDecodeError:
        print('  [错误] config.json 格式有误，请检查 JSON 语法。\n')
        return None


def to_groq(body_bytes):
    """将 Anthropic 格式请求转换为 Groq (OpenAI 兼容) 格式。"""
    data     = json.loads(body_bytes)
    messages = data.get('messages', [])

    groq_messages = []
    has_image = False
    for msg in messages:
        raw  = msg.get('content', '')
        role = 'user' if msg.get('role') == 'user' else 'assistant'

        if isinstance(raw, str):
            content = raw
        elif isinstance(raw, list):
            content = []
            for item in raw:
                t = item.get('type', '')
                if t == 'text':
                    content.append({'type': 'text', 'text': item['text']})
                elif t == 'image':
                    src = item.get('source', {})
                    if src.get('type') == 'base64':
                        has_image = True
                        media_type = src.get('media_type', 'image/jpeg')
                        content.append({
                            'type': 'image_url',
                            'image_url': {
                                'url': f"data:{media_type};base64,{src.get('data', '')}"
                            }
                        })
        else:
            content = str(raw)

        groq_messages.append({'role': role, 'content': content})

    groq_messages.insert(0, {
        'role': 'system',
        'content': (
            'Output ONLY valid JSON with no markdown fences, no comments, '
            'no trailing commas, no single quotes. '
            'All keys and string values must use double quotes.'
        )
    })

    groq_req = {
        'model':           GROQ_MODEL_VISION if has_image else GROQ_MODEL_TEXT,
        'messages':        groq_messages,
        'max_tokens':      data.get('max_tokens', 8192),
        'temperature':     0.1,
        'response_format': {'type': 'json_object'},
    }
    return json.dumps(groq_req).encode('utf-8')


def strip_fences(text):
    text = text.strip()
    text = re.sub(r'^```(?:json|JSON)?\s*\n?', '', text)
    text = re.sub(r'\n?```\s*$', '', text)
    return text.strip()


def from_groq(resp_bytes):
    """将 Groq 响应转换为前端期望的格式。返回 (body, http_status)。"""
    data = json.loads(resp_bytes)

    if 'error' in data:
        err = data['error']
        msg = err.get('message', 'Groq API 错误')
        print(f'  [Groq ERROR] {err.get("code")} {msg}')
        out = json.dumps({'error': {'message': msg}}).encode()
        return out, 502

    text = ''
    try:
        choice = data['choices'][0]
        reason = choice.get('finish_reason', '')
        print(f'  [Groq] finish_reason={reason}')
        raw = choice['message']['content']
        if reason == 'length':
            print(f'  [WARN] 响应被截断（length），已收到 {len(raw)} 字符')
        text = strip_fences(raw)
    except (KeyError, IndexError) as e:
        text = '响应解析失败: ' + str(e)

    print(f'  [Groq text 前200字] {text[:200]}')

    result = json.dumps({'content': [{'type': 'text', 'text': text}]}).encode('utf-8')
    return result, 200


API_KEY = load_api_key()


class Handler(BaseHTTPRequestHandler):

    def _send(self, status, body, content_type='application/json'):
        """Send a complete response and close the connection."""
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_OPTIONS(self):
        rid = next_req_id()
        print(f'  [{rid}] OPTIONS {self.path}')
        self._send(200, b'')
        print(f'  [{rid}] OPTIONS 已响应')

    def do_GET(self):
        rid = next_req_id()
        print(f'  [{rid}] GET {self.path}')
        if self.path in ('/ping', '/api/ping'):
            self._send(200, b'{"pong":true}')
            print(f'  [{rid}] /ping OK')
            return
        if self.path in ('/', '/index.html'):
            html_path = os.path.join(BASE_DIR, 'index.html')
            try:
                with open(html_path, 'rb') as f:
                    html = f.read()
                self._send(200, html, 'text/html; charset=utf-8')
                print(f'  [{rid}] index.html 已发送 ({len(html)} bytes)')
            except FileNotFoundError:
                self._send(404, b'Not Found', 'text/plain')
        else:
            self._send(404, b'Not Found', 'text/plain')

    def do_POST(self):
        rid = next_req_id()
        print(f'  [{rid}] POST {self.path} 已收到')

        if self.path not in ('/proxy', '/api/proxy'):
            self._send(404, b'Not Found', 'text/plain')
            return

        if not API_KEY:
            err = json.dumps({'error': {'message': 'API Key 未配置，请编辑 config.json'}}).encode()
            self._send(500, err)
            return

        length = int(self.headers.get('Content-Length', 0))
        body   = self.rfile.read(length)
        print(f'  [{rid}] 请求体已读取 ({length} bytes)')

        try:
            groq_body = to_groq(body)
        except Exception as e:
            err = json.dumps({'error': {'message': f'请求转换失败: {e}'}}).encode()
            self._send(400, err)
            return

        req = urllib.request.Request(
            GROQ_ENDPOINT, data=groq_body, method='POST',
            headers={
                'Content-Type':  'application/json',
                'Authorization': f'Bearer {API_KEY}',
            }
        )

        print(f'  [{rid}] 正在调用 Groq API...')
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                raw = resp.read()
            print(f'  [{rid}] Groq 返回 {len(raw)} bytes')
            result, status = from_groq(raw)
            self._send(status, result)
            print(f'  [{rid}] 响应已发送 (HTTP {status}, {len(result)} bytes)')

        except urllib.error.HTTPError as e:
            raw = e.read()
            print(f'  [{rid}] Groq HTTP Error {e.code}: {raw[:200]}')
            try:
                err_data = json.loads(raw)
                out = json.dumps({'error': err_data.get('error', {'message': f'HTTP {e.code}'})}).encode()
            except Exception:
                out = json.dumps({'error': {'message': f'HTTP {e.code}'}}).encode()
            self._send(502, out)

        except Exception as e:
            print(f'  [{rid}] 异常: {type(e).__name__}: {e}')
            out = json.dumps({'error': {'message': str(e)}}).encode()
            self._send(502, out)

    def log_message(self, fmt, *args):
        pass  # 全部使用自定义日志，屏蔽默认输出


if __name__ == '__main__':
    if not API_KEY:
        input('  按回车键退出...')
        sys.exit(1)

    # 监听所有接口（含 IPv4 和 IPv6），多线程处理
    server = ThreadingHTTPServer(('', PORT), Handler)
    print()
    print(f'  [OK] Hand-Carry Tool started (Groq text={GROQ_MODEL_TEXT}, vision={GROQ_MODEL_VISION})')
    print(f'  Browser: http://localhost:{PORT}')
    print(f'  Threaded mode, listening on all interfaces')
    print()
    print('  Keep this window open. Press Ctrl+C to stop.')
    print('  -----------------------------------------')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  已停止。')
        sys.exit(0)
