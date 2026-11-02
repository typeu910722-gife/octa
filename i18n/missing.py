# Lists interface text in app/ that has no translation yet.
# Run `python3 i18n/missing.py` after changing the web app; add what it prints to strings.py.
# It reads every string in app/index.html and app/js/*.js (a small JavaScript lexer, so strings inside
# ${…} of template literals are found too), splits HTML templates into their text pieces (the same
# pieces the page shows; i18n-core.js translates one text node or attribute at a time) and checks each
# piece against T and the P patterns. Text inside data-u (names, messages) is never translated, so a
# few pieces it would list (prompts sent to a bot) are left out on purpose — see SKIP.
import os, re, sys, json, html
sys.path.insert(0, os.path.dirname(__file__))
from strings import T, P
ROOT = os.path.join(os.path.dirname(__file__), '..', 'app')
HAN = re.compile(r'[㐀-鿿！-～　-〿]')
# whole strings that are sent to bots or matched against bot text, never shown as interface text
SKIP = re.compile(r'^(請執行技能|核准：|不要做：|不用了：|登入好了|（待命巡查）|其他 AI 把工作交接給你|用三到五句話|根據目前的對話|用幾句話告訴我|計畫要改|你現在是我|要把工作交給 OCTA|」時，用 HTTP POST|待命巡查$|外部交接$|（附件）$|（複製）$|（Grok）$|（以後這類事一律允許|。這件事先停下)')

# pieces of a text node that also holds a value (the whole line is matched by a P pattern), brand
# names inside data-u, and characters that are only a fallback letter
SPLIT = {'OCTA 奧克塔', '奧克塔', '小時內', '（HTTP', '）', '字', '🔁 幕後', '處理', '中…', '找不到「', '目前：開啟，每', '分鐘巡查一次',
         '「估計省下」是粗略估計：每件完成的工作算', '分鐘，有用到瀏覽器的再加', '分鐘，不是實際量測。tokens 只計算有回報用量的 AI。最多保留 60 天。'}

def lex(src):
    """Every string literal in a script: plain strings, and template literals with ${…} replaced by \\0."""
    out, n = [], len(src)
    def read_str(i, q):
        j = i + 1; buf = ''
        while j < n and src[j] != q:
            if src[j] == '\\': buf += src[j + 1] if src[j + 1] != 'n' else '\n'; j += 2; continue
            buf += src[j]; j += 1
        out.append(buf); return j + 1
    def read_template(i):   # i: just after the opening `
        buf = ''
        while i < n:
            c = src[i]
            if c == '\\': buf += src[i + 1] if src[i + 1] != 'n' else '\n'; i += 2; continue
            if c == '`': out.append(buf); return i + 1
            if c == '$' and src[i + 1] == '{': buf += '\x00'; i = read_code(i + 2, True); continue
            buf += c; i += 1
        return i
    def read_code(i, inner=False):
        depth, prev = 0, '('
        while i < n:
            c = src[i]
            if c in '\'"': i = read_str(i, c); prev = 'a'; continue
            if c == '`': i = read_template(i + 1); prev = 'a'; continue
            if src.startswith('//', i): i = src.find('\n', i); i = n if i < 0 else i; continue
            if src.startswith('/*', i): i = src.find('*/', i) + 2; continue
            if c == '/' and prev in '(,=:[!&|?{};+-*%<>~^' :   # a regular expression literal
                j, cls = i + 1, False
                while j < n:
                    if src[j] == '\\': j += 2; continue
                    if src[j] == '[': cls = True
                    elif src[j] == ']': cls = False
                    elif src[j] == '/' and not cls: break
                    j += 1
                i = j + 1; prev = 'a'; continue
            if c == '{': depth += 1
            elif c == '}':
                if inner and depth == 0: return i + 1
                depth -= 1
            if not c.isspace(): prev = c if not (c.isalnum() or c in '_$)].') else 'a'
            i += 1
        return i
    read_code(0)
    return out

def pieces(s):
    out = []
    for m in re.finditer(r'(?:placeholder|title|aria-label|alt)="([^"]*)"', s): out += m.group(1).split('\x00')
    s = re.sub(r'<[^>]*>', '\x00', s)
    out += s.split('\x00')
    return [x.strip() for x in out if x.strip() and HAN.search(x)]

def known(k):
    if k in T: return True
    return any(re.search(rx, k) for rx, *_ in P)

def scan():
    miss = {}
    files = [os.path.join(ROOT, 'index.html')] + sorted(os.path.join(ROOT, 'js', f) for f in os.listdir(os.path.join(ROOT, 'js')) if f.endswith('.js'))
    for f in files:
        src = open(f, encoding='utf8').read()
        strs = [re.sub(r'<script[\s\S]*?</script>', '', src)] if f.endswith('.html') else lex(src)
        for s in strs:
            if SKIP.match(s.strip()): continue
            for k in pieces(s):
                k = html.unescape(k)
                if known(k): continue
                for line in k.split('\n'):
                    line = line.strip()
                    if not line or not HAN.search(line) or SKIP.match(line) or line in SPLIT or known(line): continue
                    miss.setdefault(line, os.path.basename(f))
    return miss

if __name__ == '__main__':
    m = scan()
    if '--json' in sys.argv: print(json.dumps(m, ensure_ascii=False, indent=1))
    else:
        for k, f in m.items(): print(f'{f}\t{k}')
        print(len(m), 'missing', file=sys.stderr)
