"""Canva design JSON -> structured pages (sections of ordered blocks)."""
import json, re, sys

c = json.load(open('content.json'))
d = json.load(open('bootstrap.json'))
N = d['page']['Pm']['N']
FAM = {}
for k, v in N.items():
    if isinstance(v, list):
        for x in v:
            if isinstance(x, dict) and str(x.get('A', '')).startswith('YA') and 'C' in x:
                FAM[x['A']] = x['C']
MEDIA = {m['id']: m for m in N['D']}
VIDEO = {m['id']: m for m in N['o']}

SKIP = {1, 4, 15, 19, 24, 28} | set(range(45, 53))  # 0-based (his 1-based 2,5,16,20,25,29,46-53)


def px(v):
    try: return float(str(v).replace('px', ''))
    except Exception: return None


def flatten(el, ox, oy, sc, out):
    if not isinstance(el, dict): return
    t = el.get('A?')
    # Canva: A = top, B = left, D = width, C = height
    y = oy + (el.get('A') or 0) * sc
    x = ox + (el.get('B') or 0) * sc
    w = (el.get('D') or 0) * sc
    h = (el.get('C') or 0) * sc
    link = el.get('G') if isinstance(el.get('G'), str) and not el['G'].endswith('px') else None
    if t == 'H':
        inner = el.get('b') or el.get('D') or 1
        s2 = sc * ((el.get('D') or inner) / inner)
        n0 = len(out)
        for ch in el.get('c') or []:
            flatten(ch, x, y, s2, out)
        if link:
            for o in out[n0:]:
                o.setdefault('link', link)
        return
    base = {'x': x, 'y': y, 'w': w, 'h': h}
    if link: base['link'] = link
    if t == 'K':
        a = el['a']['C']
        paras = [p.rstrip('\n') for p in a['A']]
        styles = a['C']
        sizes = [px(s['G']) for s in styles if isinstance(s, dict) and 'G' in s]
        first = next((s for s in styles if isinstance(s, dict) and 'C' in s), {})
        color = next((s['M'] for s in styles if isinstance(s, dict) and 'M' in s), '#ffffff')
        font = FAM.get(str(first.get('C', '')).split(',')[0], '')
        align = first.get('c', 'left')
        bold = any(isinstance(s, dict) and (s.get('B') in ('700', 700, 'bold')) for s in styles)
        ital = any(isinstance(s, dict) and s.get('A') == 'italic' for s in styles)
        upper = any(isinstance(s, dict) and s.get('S') == 'uppercase' for s in styles)
        lst = any(isinstance(s, dict) and s.get('P') for s in styles)
        txt = '\n'.join(paras).strip()
        if not txt: return
        grads = (el['a'].get('E') or {})
        gref = next((s.get('BG') for s in styles if isinstance(s, dict) and s.get('BG')), None)
        grad = None
        if gref and gref in grads:
            g = (grads[gref].get('K') or {})
            grad = {'stops': [(x.get('A'), x.get('C', 0)) for x in g.get('A', [])], 'angle': g.get('B', 0)}
        effects = [x.get('A') for x in ((el.get('j') or {}).get('A') or []) if isinstance(x, dict)]
        spacing = next((s.get('W') for s in styles if isinstance(s, dict) and s.get('W')), None)
        lh = next((s.get('Y') for s in styles if isinstance(s, dict) and s.get('Y')), None)
        deco = 'underline' if any(isinstance(s, dict) and s.get('O') == 'underline' for s in styles) else None
        base.update({'grad': grad, 'effects': effects, 'spacing': spacing, 'lh': lh, 'deco': deco})
        # A stretched text box: 'e' is its unstretched width, so the font scales by D/e.
        k = (el.get('D') / el['e']) if el.get('e') and el.get('D') else 1.0
        out.append({**base, 'type': 'text', 'text': txt, 'paras': [p for p in paras],
                    'size': (sizes[0] if sizes else 20) * sc * k, 'size2': (sizes[1] * sc * k if len(sizes) > 1 else None),
                    'color': color, 'font': font, 'align': align, 'bold': bold, 'italic': ital, 'upper': upper, 'list': lst})
    elif t == 'I':
        a = el.get('a') or {}
        if isinstance(a.get('I'), dict) and a['I'].get('A'):
            out.append({**base, 'type': 'video', 'id': a['I']['A'], 'opacity': el.get('F')})
            return
        ref = ((a.get('B') or {}).get('A') or {})
        mid = ref.get('A')
        if not mid: return
        crop = (a.get('B') or {}).get('B') or {}
        if crop:
            base['crop'] = {'y': crop.get('A', 0), 'x': crop.get('B', 0), 'w': crop.get('D'), 'h': crop.get('C'), 'fw': el.get('D'), 'fh': el.get('C')}
        if isinstance(el.get('E'), (int, float)): base['rot'] = el['E']
        kind = 'video' if mid in VIDEO or str(mid).startswith('VA') else 'image'
        out.append({**base, 'type': kind, 'id': mid, 'opacity': el.get('F')})
    elif t == 'J':
        vb = el.get('a') or {}
        paths = []
        for b in el.get('b') or []:
            if not isinstance(b, dict): continue
            fill = b.get('B') or {}
            f = None
            if isinstance(fill, dict):
                if fill.get('C'): f = {'color': fill['C']}
                elif isinstance(fill.get('K'), dict): f = {'stops': [(x.get('A'), x.get('C', 0)) for x in fill['K'].get('A', [])], 'angle': fill['K'].get('B', 0)}
            st = b.get('C') if isinstance(b.get('C'), dict) else None
            paths.append({'d': b.get('A'), 'fill': f, 'stroke': {'w': st.get('A'), 'c': st.get('B')} if st else None})
        out.append({**base, 'type': 'shape', 'vb': [vb.get('D', 64), vb.get('C', 64)], 'paths': paths, 'opacity': el.get('F')})
    elif t == 'U':
        out.append({**base, 'type': 'line', 'color': el.get('d'), 'thick': el.get('a') if isinstance(el.get('a'), (int, float)) else 2, 'rot': el.get('E') or 0})
    elif t == 'O':
        out.append({**base, 'type': 'embed', 'url': el.get('a')})


pages = []
for i, pg in enumerate(c['A']):
    if i in SKIP: continue
    secs = []
    for s in pg['t']:
        out = []
        for el in s.get('E') or []:
            flatten(el, 0, 0, 1.0, out)
        bg = (s.get('D') or {}).get('C')
        hgt = (s.get('C') or {}).get('B', 768)
        secs.append({'h': hgt, 'bg': bg, 'els': out})
    pages.append({'idx': i, 'canva_page': i + 1, 'title': (pg.get('B') or '').strip(), 'pid': pg.get('P'), 'sections': secs})

json.dump(pages, open('pages.json', 'w'), indent=1)
print(len(pages), 'pages')
for p in pages:
    n = sum(len(s['els']) for s in p['sections'])
    print(p['canva_page'], p['pid'], p['title'], len(p['sections']), 'sections', n, 'els')
