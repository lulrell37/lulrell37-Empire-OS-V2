"""pages.json -> responsive static site in ../site (copied into the repo's site/empire)."""
import json, re, os, html, shutil, difflib

OUT = os.environ.get('OUT', 'site')
W = 1366.0
pages = json.load(open('pages.json'))
plan = json.load(open('media_plan.json'))
HAVE = {os.path.splitext(f)[0]: f for f in os.listdir('web')}
HAVE.update({os.path.splitext(f)[0]: f for f in os.listdir('vid')})

FONT = {
    'Cinzel': "'Cinzel', serif", 'Cinzel Decorative': "'Cinzel Decorative', serif", 'Abril Fatface': "'Abril Fatface', serif",
    'Shrikhand': "'Shrikhand', cursive", 'Black Ops One': "'Black Ops One', cursive", 'Arimo': "'Arimo', sans-serif",
    'Be Vietnam': "'Be Vietnam Pro', sans-serif", 'Tiro Bangla': "'Tiro Bangla', serif", 'Moontime': "'Great Vibes', cursive",
    'Madelyn': "'Great Vibes', cursive", 'Chloe': "'Playfair Display', serif", 'Gagalin': "'Anton', sans-serif",
    'Ahsing': "'Anton', sans-serif", 'Sifonn': "'Montserrat', sans-serif", 'Ahkio': "'Montserrat', sans-serif",
    'Horizon': "'Michroma', sans-serif", 'Rustic Printed Stamp': "'Special Elite', cursive", 'Canva Sans': "'Inter', sans-serif",
    'Times New Roman': "'Times New Roman', serif", 'Times New Roman MT': "'Times New Roman', serif", 'Arial': "Arial, sans-serif",
}
GFONTS = 'family=Cinzel:wght@400;700&family=Cinzel+Decorative:wght@700&family=Abril+Fatface&family=Shrikhand&family=Black+Ops+One&family=Arimo:wght@400;700&family=Be+Vietnam+Pro:wght@400;700&family=Tiro+Bangla&family=Great+Vibes&family=Playfair+Display:wght@400;700&family=Anton&family=Montserrat:wght@400;800&family=Michroma&family=Special+Elite&family=Inter:wght@400;700'

# Nice names + slugs
NAMES = {'The Empire': 'Home', 'Menu': 'Menu', 'Lets Do Business': "Let's Do Business", 'deals': 'Deals', 'marketplace': 'Marketplace',
         'digital products': 'Digital Products', 'ai business': 'AI Business', 'affiliate marketing': 'Affiliate Marketing',
         'Financial terms': 'Financial Terms', 'Application assistance': 'Application Assistance', 'Life Insurance opportunity': 'Life Insurance Opportunity'}


def slugify(t):
    return re.sub(r'[^a-z0-9]+', '-', t.lower()).strip('-')


seen = {}
for p in pages:
    name = NAMES.get(p['title'], p['title'].strip() or 'Page')
    if p['title'] == 'Time to get rich':
        name = 'Time to Get Rich' if 'Time to Get Rich' not in seen else 'Time to Get Rich (Part 2)'
    name = name[0].upper() + name[1:]
    slug = 'index' if p['idx'] == 0 else slugify(name)
    while slug in seen.values():
        slug += '-2'
    seen[name] = slug
    p['name'], p['slug'] = name, slug
BY_PID = {p['pid']: p for p in pages if p['pid']}
PAGE_FOR = {}
for p in pages:
    PAGE_FOR[p['name'].lower()] = p
    PAGE_FOR[p['title'].lower().strip()] = p
# Labels used on the Map / home that name a page differently.
ALIAS = {'the blueprint': 'Blueprint', 'blueprint': 'Blueprint', 'job acquisition': 'Remote Jobs', 'job\nacquisition': 'Remote Jobs',
         'donate to charity': 'Charity', 'i want to donate to charity': 'Charity', 'empire store': 'Empire Merch', 'empire\nstore': 'Empire Merch',
         'empire merchandise': 'Empire Merch', 'networking center': 'Networking', 'networking\ncenter': 'Networking', 'networking': 'Networking',
         'financial literacy': 'Financial Literacy', 'we teach financial literacy': 'Financial Literacy', 'services': 'Consulting',
         'deals': 'Deals', 'gym': 'Gym', 'church': 'Church', 'discipline': 'Discipline', 'motivation': 'Motivation', 'money': 'Money',
         'opportunity': 'Opportunity', "lets do business": "Let's Do Business", 'business': "Let's Do Business", 'heavenly father': 'Church',
         'i want to make  money': 'Money', 'i want to make money': 'Money', 'i want to level up mentaly': 'Motivation',
         'i want to level up my life': 'Discipline', 'i want to network': 'Networking', 'i want to start a business': 'Entrepreneurship',
         'i want to learn about money': 'Financial Literacy', 'im looking for a service': 'Consulting', 'use the blueprint': 'Blueprint',
         'tour the empire': 'Empire Map', 'tour': 'Empire Map', 'empire map': 'Empire Map', 'map': 'Empire Map', 'home': 'Home',
         'inspiration': 'Motivation', 'upgrade your life': 'Discipline', 'programs': 'Blueprint', 'stores': 'Empire Merch',
         'resurrection': 'Church', 'legal': 'Disclaimers', 'terms & conditions': 'Disclaimers', 'invest': 'Invest',
         'entrepreneurship': 'Entrepreneurship', 'testimonials': 'Testimonials', 'remote jobs': 'Remote Jobs', 'consulting': 'Consulting',
         'chest': 'Chest', 'arms': 'Arms', 'back': 'Back', 'core': 'Core', 'legs': 'Legs', 'full body': 'Full body', 'boxing': 'Boxing',
         'digital products': 'Digital Products', 'ai business': 'AI Business', 'affiliate marketing': 'Affiliate Marketing',
         'digital real estate': 'Digital real estate', 'marketplace': 'Marketplace', 'time to get rich': 'Time to Get Rich',
         'financial terms': 'Financial Terms', 'application assistance': 'Application Assistance', 'life insurance': 'Life Insurance Opportunity',
         'charity': 'Charity', 'tarell burrus': 'Home'}
FORMS = re.compile(r'^(contact me|apply here|rsvp( here)?|reserve your seat|secure your seat|set up auto apply\??|subscribe.*|book (a )?call.*|get started)$', re.I)


def page_link(text):
    k = re.sub(r'\s+', ' ', text.strip().lower()).strip(' .!?:')
    k2 = text.strip().lower()
    name = ALIAS.get(k2) or ALIAS.get(k)
    if name:
        for p in pages:
            if p['name'].lower() == name.lower() or p['title'].strip().lower() == name.lower():
                return p
    return None


def href(p):
    return './' if p['slug'] == 'index' else f"{p['slug']}.html"


def media(mid):
    f = HAVE.get(mid)
    return f"media/{f}" if f else None


def esc(t):
    return html.escape(t, quote=True)


def autolink(t):
    t = esc(t)
    t = re.sub(r'(?<![\w/])(\d{3}[-.\s]\d{3}[-.\s]\d{4})', lambda m: f'<a href="tel:{re.sub(r"[^0-9]", "", m.group(1))}">{m.group(1)}</a>', t)
    t = re.sub(r'(?<![\w/@])([a-z0-9-]+\.(?:com|net|org|io|co))(?![\w])', r'<a href="https://\1" target="_blank" rel="noopener">\1</a>', t)
    return t


def is_footer(sec):
    txt = ' '.join(e.get('text', '') for e in sec['els'] if e['type'] == 'text').lower()
    return ('terms & conditions' in txt and ('legal' in txt or 'contact me' in txt) and sec['h'] < 900) or (
        'tour the empire' in txt and 'contact me' in txt)



def pct(v, of):
    return f"{v / of * 100:.3f}%"


def grad_css(g):
    stops = ', '.join(f"{c} {round((o or 0) * 100)}%" for c, o in g['stops'] if c)
    return f"linear-gradient({(g.get('angle') or 0) + 90:.0f}deg, {stops})"


def text_inner(e, page):
    t = e['text']
    paras = t.split('\n')
    if len(paras) > 2:
        return ''.join(f'<p>{autolink(x)}</p>' if x.strip() else '<p class="gap"></p>' for x in paras)
    return '<br>'.join(autolink(x) for x in paras)


# Stand-in fonts that run bigger than the Canva font they replace.
FONT_SCALE = {'Ahsing': 0.72, 'Gagalin': 0.8, 'Moontime': 1.0, 'Madelyn': 1.0, 'Sifonn': 0.85, 'Horizon': 0.8}


def text_style(e):
    fam = FONT.get(e['font'], "'Inter', sans-serif")
    k = FONT_SCALE.get(e['font'], 1.0)
    e = {**e, 'size': e['size'] * k, 'size2': (e['size2'] * k if e.get('size2') else None)}
    align = {'center': 'center', 'right': 'right', 'end': 'right', 'justify': 'justify'}.get(e['align'], 'left')
    st = f"--fs:{e['size']:.2f};font-family:{fam};color:{e['color']};text-align:{align};"
    if e.get('size2'): st += f"--fs2:{e['size2']:.2f};"
    if e['bold']: st += 'font-weight:700;'
    if e['italic']: st += 'font-style:italic;'
    if e.get('deco'): st += 'text-decoration:underline;'
    if e.get('spacing'): st += f"letter-spacing:{e['spacing']};"
    if e.get('lh'): st += f"line-height:{e['lh']};"
    if e.get('grad'):
        st += f"background:{grad_css(e['grad'])};-webkit-background-clip:text;background-clip:text;color:transparent;"
    if 'neon' in (e.get('effects') or []):
        glow = (e['grad']['stops'][-1][0] if e.get('grad') else e['color']) or '#fff'
        st += f"color:#fff;background:none;-webkit-background-clip:border-box;text-shadow:0 0 .08em #fff,0 0 .25em {glow},0 0 .6em {glow};"
    if e.get('upper'): st += 'text-transform:uppercase;'
    if '\n' not in e['text'].strip() and len(e['text']) < 40: st += 'white-space:nowrap;'
    return st


def shape_svg(e):
    vw_, vh_ = e['vb']
    defs, body = '', ''
    for i, pth in enumerate(e['paths']):
        f = pth.get('fill')
        fill = 'none'
        if f and f.get('color'):
            fill = f['color']
        elif f and f.get('stops'):
            gid = f"g{abs(hash(str(f))) % 10**8}{i}"
            defs += f'<linearGradient id="{gid}" gradientTransform="rotate({f.get("angle") or 0},.5,.5)">' + ''.join(f'<stop offset="{o or 0}" stop-color="{c}"/>' for c, o in f['stops'] if c) + '</linearGradient>'
            fill = f'url(#{gid})'
        stroke = ''
        if pth.get('stroke') and pth['stroke'].get('c'):
            stroke = f' stroke="{pth["stroke"]["c"]}" stroke-width="{pth["stroke"].get("w") or 1}" vector-effect="non-scaling-stroke"'
        body += f'<path d="{esc(pth.get("d") or "")}" fill="{fill}"{stroke}/>'
    return f'<svg viewBox="0 0 {vw_} {vh_}" preserveAspectRatio="none">{"<defs>" + defs + "</defs>" if defs else ""}{body}</svg>'


def box(e, W_, H_, extra=''):
    return (f"left:{pct(e['x'], W_)};top:{pct(e['y'], H_)};width:{pct(e['w'], W_)};height:{pct(e['h'], H_)};--w:{e['w'] / W_ * 100:.2f};{extra}")


def el_html(e, page, W_, H_, in_group=False):
    t = e['type']
    op = f"opacity:{e['opacity']};" if e.get('opacity') not in (None, 1) else ''
    rot = f"transform:rotate({e['rot']}deg);" if e.get('rot') else ''
    if t == 'text':
        st = box(e, W_, H_, text_style(e) + rot)
        txt = e['text'].strip()
        if FORMS.match(txt):
            return f'<button class="el tx btn" data-form="{esc(txt)}" style="{st}">{esc(txt)}</button>'
        target = page_link(txt)
        link = e.get('link')
        if target and target is not page and len(txt) < 60:
            return f'<a class="el tx go" href="{href(target)}" style="{st}">{text_inner(e, page)}</a>'
        if link and str(link).startswith('http'):
            return f'<a class="el tx go" href="{esc(link)}" target="_blank" rel="noopener" style="{st}">{text_inner(e, page)}</a>'
        if link == '#page-2':
            return f'<a class="el tx go" href="menu.html" style="{st}">{text_inner(e, page)}</a>'
        tag = 'h2' if e['size'] >= 40 and len(txt) < 90 else 'div'
        return f'<{tag} class="el tx" style="{st}">{text_inner(e, page)}</{tag}>'
    if t in ('image', 'video'):
        src = media(e['id'])
        if not src:
            return ''
        inner_st = ''
        c = e.get('crop')
        if c and c.get('w') and c.get('fw'):
            inner_st = f"position:absolute;left:{c['x'] / c['fw'] * 100:.3f}%;top:{c['y'] / c['fh'] * 100:.3f}%;width:{c['w'] / c['fw'] * 100:.3f}%;height:{c['h'] / c['fh'] * 100:.3f}%;max-width:none;object-fit:fill;"
        else:
            inner_st = 'width:100%;height:100%;object-fit:cover;'
        if t == 'video':
            small = e['w'] < 700
            m = f'<video src="{src}" style="{inner_st}" autoplay muted loop playsinline preload="metadata"{" controls" if small else ""}></video>'
        else:
            m = f'<img src="{src}" alt="" loading="lazy" style="{inner_st}">'
        cls = 'el md' + (' vd' if t == 'video' else '')
        link = e.get('link')
        st = box(e, W_, H_, op + rot + f"aspect-ratio:{e['w']:.1f}/{max(e['h'], 1):.1f};")
        if link and str(link).startswith('http'):
            return f'<a class="{cls} go" href="{esc(link)}" target="_blank" rel="noopener" style="{st}">{m}</a>'
        if link == '#page-2':
            return f'<a class="{cls} go" href="menu.html" style="{st}">{m}</a>'
        return f'<div class="{cls}" style="{st}">{m}</div>'
    if t == 'shape':
        return f'<div class="el sh" style="{box(e, W_, H_, op + rot)}">{shape_svg(e)}</div>'
    if t == 'line':
        return f'<div class="el ln" style="{box(e, W_, H_, f"border-top:{e.get("thick") or 2}px solid {e.get("color") or "#fff"};height:0;" + rot)}"></div>'
    if t == 'embed':
        return f'<div class="el emb" style="{box(e, W_, H_)}"><iframe src="{esc(e["url"])}" loading="lazy" allow="autoplay; encrypted-media"></iframe></div>'
    return ''


def overlaps(a, b, frac=0.3):
    ix = max(0, min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x']))
    iy = max(0, min(a['y'] + a['h'], b['y'] + b['h']) - max(a['y'], b['y']))
    small = min(a['w'] * a['h'], b['w'] * b['h']) or 1
    return ix * iy / small > frac


def clusters(els):
    """Elements stacked on each other (the logo: crown + TB + name) stay one piece on a phone."""
    par = list(range(len(els)))
    def f(i):
        while par[i] != i:
            par[i] = par[par[i]]; i = par[i]
        return i
    for i in range(len(els)):
        for j in range(i + 1, len(els)):
            a, b = els[i], els[j]
            if a['w'] > W * 0.7 or b['w'] > W * 0.7:
                continue  # a full-width frame or strip isn't part of a logo-like stack
            if a['type'] in ('image', 'video', 'shape') or b['type'] in ('image', 'video', 'shape'):
                if overlaps(a, b):
                    par[f(i)] = f(j)
    groups = {}
    for i in range(len(els)):
        groups.setdefault(f(i), []).append(els[i])
    return list(groups.values())


def section_html(sec, page, first):
    H = max(sec['h'] or 768, 1)
    bg, rest = None, []
    for e in sec['els']:
        covers = e['w'] >= W * 0.8 and e['h'] >= H * 0.6 and e['type'] in ('image', 'video', 'shape')
        if covers:
            if e['type'] == 'shape':
                p0 = (e['paths'] or [{}])[0].get('fill') or {}
                if p0.get('color') and bg is None:
                    bg = {'color': p0['color'], 'opacity': e.get('opacity')}
                continue
            if media(e['id']):
                bg = e
            elif bg is None:
                bg = {'color': '#0b0b0b', 'texture': True}  # a Canva Pro stock background: our own dark texture instead
            continue
        if first and e['y'] < 95 and e['h'] < 100 and (e['type'] in ('image', 'video') or (e['type'] == 'text' and e['size'] < 30)):
            continue  # Canva's small logo / menu icon / name in the corner: the site has a real header
        if e['type'] in ('image', 'video') and not media(e['id']):
            continue
        if e['y'] > H or e['x'] > W or e['x'] + e['w'] < 0 or e['y'] + e['h'] < 0:
            continue
        rest.append(e)
    rest.sort(key=lambda e: (e['y'], e['x']))
    parts = []
    for g in clusters(rest):
        if len(g) == 1 or all(x['type'] in ('text', 'shape', 'line') for x in g) and not any(x['type'] == 'shape' for x in g):
            for e in g:
                parts.append((e['y'], e['x'], el_html(e, page, W, H)))
            continue
        gx = min(e['x'] for e in g); gy = min(e['y'] for e in g)
        gw = max(e['x'] + e['w'] for e in g) - gx; gh = max(e['y'] + e['h'] for e in g) - gy
        inner = ''.join(el_html({**e, 'x': e['x'] - gx, 'y': e['y'] - gy}, page, gw, gh, True) for e in sorted(g, key=lambda e: 0 if e['type'] == 'shape' else 1))
        gbox = {'x': gx, 'y': gy, 'w': gw, 'h': gh}
        parts.append((gy, gx, f'<div class="el grp" style="{box(gbox, W, H)}--gw:{gw:.1f};aspect-ratio:{gw:.1f}/{max(gh, 1):.1f}">{inner}</div>'))
    parts.sort()
    body = ''.join(h for _, _, h in parts if h)
    bghtml, bgcol = '', sec.get('bg') or '#000'
    if bg and bg.get('color'):
        bgcol = bg['color'] + (';background-image:url(media/texture.svg)' if bg.get('texture') else '')
    elif bg:
        src = media(bg['id'])
        op = bg.get('opacity') or 1
        tag = (f'<video class="bg" src="{src}" autoplay muted loop playsinline style="opacity:{op}"></video>' if bg['type'] == 'video'
               else f'<img class="bg" src="{src}" alt="" style="opacity:{op}">')
        bghtml = tag
    return f'<section class="cv" style="background-color:{bgcol};--h:{H:.1f};--ar:{W:.0f}/{H:.1f};aspect-ratio:{W:.0f}/{H:.1f}">{bghtml}{body}</section>'


MAIN_NAV = ['Home', 'Empire Map', 'Motivation', 'Financial Literacy', 'Blueprint', 'Remote Jobs', 'Gym', 'Empire Merch']


def nav_html(cur):
    links = []
    for n in MAIN_NAV:
        p = next((q for q in pages if q['name'] == n), None)
        if p:
            links.append(f'<a href="{href(p)}"{" aria-current=page" if p is cur else ""}>{esc(n)}</a>')
    return f'''<header class="top"><a class="brand" href="./"><img src="media/MAG_nndPcYQ.webp" alt=""><span>Tarell Burrus</span></a>
<button class="burger" aria-label="Menu" onclick="document.body.classList.toggle('open')"><i></i><i></i><i></i></button>
<nav>{"".join(links)}<a href="menu.html">All pages</a><button class="cta small" data-form="Contact me">Contact me</button></nav></header>'''


FOOT = '''<footer><div class="fwrap"><div><img src="media/MAG_nndPcYQ.webp" alt="" class="flogo"><p class="motto">Praise God | Get Money | Knowledge is Everything</p></div>
<form class="news" data-kind="newsletter"><label>News &amp; updates — subscribe to the weekly newsletter</label><div><input type="email" name="email" placeholder="Your email" required><button>Subscribe</button></div><small class="msg"></small></form>
<div class="flinks"><a href="empire-map.html">Empire Map</a><a href="menu.html">All pages</a><a href="disclaimers.html">Terms &amp; conditions</a><button class="linkish" data-form="Contact me">Contact me</button></div></div>
<p class="copy">© The Empire · Tarell Burrus · Blessed Visionary Brand 🕊</p></footer>
<dialog id="formdlg"><form class="lead" data-kind="contact" method="dialog"><h3 class="ftitle">Contact me</h3>
<input name="name" placeholder="Your name" required><input name="email" type="email" placeholder="Email"><input name="phone" placeholder="Phone">
<textarea name="message" rows="4" placeholder="What can we help with?"></textarea><input type="hidden" name="topic"><input class="hp" name="website" tabindex="-1" autocomplete="off">
<div class="btns"><button type="button" class="ghost" onclick="this.closest('dialog').close()">Cancel</button><button type="submit">Send</button></div><small class="msg"></small></form></dialog>'''


def page_html(p):
    secs = [s for s in p['sections'] if not is_footer(s)]
    if p['name'] == 'Empire Map':
        body = map_html(p)
    elif p['name'] == 'Menu':
        body = menu_html()
    else:
        body = ''.join(section_html(s, p, i == 0) for i, s in enumerate(secs))
    title = 'The Empire — Tarell Burrus' if p['slug'] == 'index' else f"{p['name']} — The Empire"
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(title)}</title><meta name="description" content="Welcome to The Empire — Tarell Burrus. Praise God | Get Money | Knowledge is Everything.">
<link rel="icon" href="media/MAG_nndPcYQ.webp"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?{GFONTS}&display=swap" rel="stylesheet"><link rel="stylesheet" href="style.css"></head>
<body class="pg-{p['slug']}">{nav_html(p)}<main>{body}</main>{FOOT}<script src="app.js"></script></body></html>'''


def map_html(p):
    labels = []
    for s in p['sections']:
        for e in s['els']:
            if e['type'] == 'text' and e['size'] > 15:
                t = re.sub(r'\s+', ' ', e['text']).strip()
                q = page_link(e['text'])
                if q and q is not p and t not in [l[0] for l in labels]:
                    labels.append((t, q))
    cards = ''.join(f'<a class="card" href="{href(q)}"><span>{esc(t)}</span></a>' for t, q in labels)
    return f'<section class="hero-map"><div class="inner"><h1 class="display">Empire Map</h1><p class="lede">Pick where you want to go.</p><div class="cards">{cards}</div></div></section>'


GROUPS = [('Start here', ['Home', 'Empire Map', 'Testimonials']),
          ('Mind & spirit', ['Motivation', 'Discipline', 'Church', 'Charity']),
          ('Money', ['Financial Literacy', 'Financial Terms', 'Money', 'Invest', 'Time to Get Rich', 'Time to Get Rich (Part 2)', 'Blueprint']),
          ('Business', ["Let's Do Business", 'Entrepreneurship', 'Digital Products', 'AI Business', 'Affiliate Marketing', 'Digital real estate', 'Consulting', 'Opportunity', 'Life Insurance Opportunity', 'Networking']),
          ('Jobs', ['Remote Jobs', 'Application Assistance']),
          ('Gym', ['Gym', 'Chest', 'Arms', 'Back', 'Core', 'Legs', 'Full body', 'Boxing']),
          ('Shop', ['Empire Merch', 'Deals', 'Marketplace']),
          ('Legal', ['Disclaimers'])]


def menu_html():
    used = set()
    out = []
    for g, names in GROUPS:
        links = []
        for n in names:
            q = next((x for x in pages if x['name'] == n), None)
            if q:
                used.add(q['slug'])
                links.append(f'<a href="{href(q)}">{esc(n)}</a>')
        out.append(f'<div class="grp"><h3>{g}</h3>{"".join(links)}</div>')
    left = [x for x in pages if x['slug'] not in used and x['name'] != 'Menu']
    if left:
        out.append('<div class="grp"><h3>More</h3>' + ''.join(f'<a href="{href(x)}">{esc(x["name"])}</a>' for x in left) + '</div>')
    return f'<section class="hero-map"><div class="inner"><h1 class="display">Menu</h1><div class="groups">{"".join(out)}</div></div></section>'


os.makedirs(OUT, exist_ok=True)
for p in pages:
    open(f"{OUT}/{p['slug']}.html", 'w').write(page_html(p))
shutil.copy('style.css', f'{OUT}/style.css')
shutil.copy('app.js', f'{OUT}/app.js')
json.dump([{'name': p['name'], 'slug': p['slug'], 'canva_page': p['canva_page']} for p in pages], open(f'{OUT}/pages.json', 'w'), indent=1)
print('wrote', len(pages), 'pages to', OUT)
