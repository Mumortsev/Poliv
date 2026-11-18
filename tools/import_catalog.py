"""Import public Technopoliv pages into GitHub Pages data files."""
import concurrent.futures
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError
from urllib.parse import quote, unquote, urljoin, urlsplit
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser
import xml.etree.ElementTree as ET

from lxml import html

ORIGIN = 'https://xn--b1afjljgahx5a.xn--p1ai'
OUTPUT = Path('site/data')
CACHE = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/technopoliv-import')
CACHE.mkdir(exist_ok=True, parents=True)
AGENT = 'TechnopolivPublicMigration/1.0'
NS = '{http://www.sitemaps.org/schemas/sitemap/0.9}'
ALLOWED = {'p', 'div', 'span', 'strong', 'b', 'i', 'em', 'br', 'hr', 'h2', 'h3', 'h4',
           'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img',
           'section', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'sup', 'sub', 'blockquote',
           'caption', 'col', 'colgroup', 'u', 'small'}
DROP = {'script', 'style', 'form', 'input', 'button', 'textarea', 'select', 'iframe',
        'object', 'embed', 'video', 'noscript', 'svg', 'link', 'meta'}
PRIORITY = ('/katalog', '/o-kompanii', '/kontakty-no1', '/dostavka-i-oplata',
            '/mail', '/news', '/nashmagazin', '/gallery',
            '/stati-v-pomosch-nachinayuschim', '/politika-konfidencialnosti', '/users/agreement',
            '/zayvka', '/forma-zayavki', '/nasosy', '/filtry', '/dozhdevanie',
            '/kapelnye-linii', '/sistemy-podachi-udobreniy', '/truboprovody',
            '/avtomatikapoliva', '/zapornaya-armatura')
REPLACED = {'/', '/magazin'}

def get(url):
    request = Request(url, headers={'User-Agent': AGENT, 'Accept': '*/*'})
    with urlopen(request, timeout=12) as response:
        return response.read(), response.geturl()

def safe_url(value, current):
    if not value or value.startswith('#'):
        return None
    url = urljoin(ORIGIN + current, value)
    parsed = urlsplit(url)
    if parsed.scheme in ('tel', 'mailto'):
        return url
    if parsed.scheme not in ('http', 'https'):
        return None
    if parsed.hostname in ('технополив.рф', 'www.технополив.рф', 'xn--b1afjljgahx5a.xn--p1ai'):
        return ORIGIN + quote(unquote(parsed.path or '/'), safe="/%:,!()-._~") + (('?' + parsed.query) if parsed.query else '')
    return url

def site_paths(raw):
    return [unquote(urlsplit(el.text or '').path or '/') for el in ET.fromstring(raw).iter(NS + 'loc')]

def txt(node):
    return ' '.join(node.text_content().split()) if node is not None else ''

def first(node, xpath):
    return next(iter(node.xpath(xpath)), None)

def class_query(name):
    return f'contains(concat(" ",normalize-space(@class)," "), " {name} ")'

def embedded(node, path, attr):
    return safe_url(node.get(attr), path) if node is not None else None

def clean(original, path, records):
    for element in list(original.iterdescendants()):
        if not isinstance(element.tag, str):
            if element.getparent() is not None: element.getparent().remove(element)
            continue
        if element.getparent() is None:
            continue
        tag = element.tag.lower()
        classes = set(element.get('class', '').split())
        if tag in DROP or classes & {'site-path','comments_block_wrapper','tpl-anketa','shop2-product-tags',
                                    'shop2-filter','shop2-sorting-panel','shop2-pagelist','g-social',
                                    'yashare','shop2-product-amount','shop2-cart','shop2-product'}:
            element.drop_tree()
            continue
        if tag not in ALLOWED:
            element.drop_tag()
            continue
        href = embedded(element, path, 'href') if tag == 'a' else None
        src = embedded(element, path, 'data-src') or embedded(element, path, 'src') if tag == 'img' else None
        attributes = {name: element.get(name) for name in ('alt','colspan','rowspan') if element.get(name)}
        element.attrib.clear()
        element.attrib.update(attributes)
        if href:
            element.set('href', href)
            records.add(href)
        if src:
            element.set('src', src)
            element.set('loading','lazy')
        if tag == 'img' and not src:
            element.drop_tree()
    return ''.join(html.tostring(element, encoding='unicode', with_tail=True) for element in original)

def parse(raw, path, final_url):
    doc = html.fromstring(raw)
    main = first(doc, '//main')
    if main is None:
        main = first(doc, '//*[@id="main"]')
    if main is None:
        if not path.startswith('/gallery/image/'):
            return None
        image = first(doc,'//img')
        source = embedded(image,path,'src')
        if not source:
            return None
        title = image.get('alt','').strip() or txt(first(doc,'//title'))
        tag = html.Element('img',src=source,alt=title,loading='lazy')
        return {'path':path,'title':title,'breadcrumb':['Фото от клиентов'],
                'type':'page','summary':'','images':[source],'content':html.tostring(tag,encoding='unicode')}
    h = first(main, './/h1')
    title = txt(h) or txt(first(doc, '//title'))
    if not title or re.match(r'^(404|Ошибка 404|Страница не найдена)',title,re.I): return None
    crumbs = first(main, f'.//*[{class_query("site-path")}]')
    breadcrumb = [txt(node) for node in crumbs.xpath('./a') if txt(node) != 'Главная'] if crumbs is not None else []
    product = first(main, f'.//form[{class_query("shop2-product")}]')
    is_product = product is not None and path.startswith('/magazin/product/')
    node = first(main, f'.//*[{class_query("site-main__inner")}]')
    if node is None:
        node = main
    result = {'path': path, 'title': title, 'breadcrumb': breadcrumb}
    final_path = unquote(urlsplit(final_url).path or '/')
    if final_path != path:
        result['redirect'] = final_path
    records = set()
    if is_product:
        result['type'] = 'product'
        result['sku'] = re.sub(r'^Артикул:\s*', '', txt(first(product, f'.//*[{class_query("shop2-product-article")}]')))
        if result['sku'] in ('нет', '—','-'): result['sku'] = ''
        result['vendor'] = txt(first(product, f'.//*[{class_query("vendor-name")}]'))
        result['price'] = txt(first(product, f'.//*[{class_query("price-current")}]'))
        result['id'] = product.xpath('string(.//input[@name="product_id"]/@value)')
        result['status'] = txt(first(product, f'.//button[{class_query("shop-product-btn")}]'))
        imgs = product.xpath(f'.//*[{class_query("card-slider__image")}]//img')
        result['images'] = list(dict.fromkeys(embedded(i,path,'src') for i in imgs if i.get('src')))
        tags = main.xpath(f'.//*[{class_query("shop2-product-tags")}]//a')
        result['tags'] = [txt(tag) for tag in tags if txt(tag)]
        desc = first(main, f'.//*[{class_query("shop-product-data__desc")}]')
        descriptions = desc.xpath(f'.//*[{class_query("desc-area")} and not(@id="shop2-tabs-01")]') if desc is not None else []
        result['content'] = ''.join(clean(detail, path, records) for detail in descriptions)
        result['summary'] = ' '.join(txt(detail) for detail in descriptions)[:260]
    elif path.startswith('/magazin/folder/') or path == '/magazin':
        result['type'] = 'category'
        result['images'] = []
        result['summary'] = ''
        result['content'] = ''
        for anchor in node.xpath('.//a[@href]'):
            link = embedded(anchor,path,'href')
            if link and '/magazin/folder/' in link:
                records.add(link)
    else:
        result['type'] = 'article' if '/article_post/' in path or '/news/news_post/' in path else 'page'
        result['summary'] = ''
        result['images'] = []
        if h is not None:
            h.drop_tree()
        result['content'] = clean(node, path, records)
        result['summary'] = txt(html.fromstring('<div>' + result['content'] + '</div>'))[:260]
    if records:
        result['links'] = sorted(records)
    return result

def build(path):
    import hashlib
    key = CACHE / (hashlib.sha1(path.encode()).hexdigest() + '.json')
    if key.exists():
        return json.loads(key.read_text())
    url = ORIGIN + quote(path, safe="/%:,!()-._~")
    if not ROBOTS.can_fetch(AGENT,url):
        return {'path':path,'error':'robots'}
    for step in range(2):
        try:
            raw, final = get(url)
            result = parse(raw, path, final) or {'path':path,'error':'no_content'}
            key.write_text(json.dumps(result, ensure_ascii=False))
            return result
        except HTTPError as error:
            if error.code in (404,410,401,403):
                result = {'path':path,'error':str(error.code)}
                key.write_text(json.dumps(result))
                return result
            if error.code in (429,503):
                time.sleep(4)
        except (OSError, ValueError, ET.ParseError):
            time.sleep(.6)
        except Exception as error:
            return {'path':path,'error':str(error)}
    return {'path':path,'error':'unavailable'}

def write_snapshot(results, sitemap, tags):
    OUTPUT.mkdir(exist_ok=True, parents=True)
    data = [r for r in results if 'error' not in r and not r.get('redirect')]
    priority = {path:index for index,path in enumerate(PRIORITY)}
    data.sort(key=lambda r: (priority.get(r['path'],99), r['title'].casefold()))
    entries = []
    for item in data:
        entry = {k:v for k,v in item.items() if k not in ('content','links')}
        if item.get('images'):
            entry['image'] = item['images'][0]
        entry.pop('images',None)
        entries.append(entry)
    groups = {f'records-{index:02}': {} for index in range(24)}
    for item in data:
        group = f'records-{sum(map(ord,item["path"])) % 24:02}'
        groups[group][item['path']] = item
    summary = {'source':ORIGIN, 'imported':datetime.now(timezone.utc).date().isoformat(),
        'sitemapCount':len(sitemap),'tagsCount':len(tags),'indexed':len(entries),
        'products':sum(e['type']=='product' for e in entries),'categories':sum(e['type']=='category' for e in entries),
        'errors':[r for r in results if 'error' in r], 'redirects':[{k:r[k] for k in ('path','redirect')} for r in results if r.get('redirect')]}
    def save(name,payload):
        target=OUTPUT / (name+'.json')
        temp=target.with_suffix('.tmp')
        temp.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')),encoding='utf-8')
        temp.replace(target)
    save('index', {'summary':summary,'items':entries})
    for group, details in groups.items():
        save(group, details)
    save('source-index', {'tags':tags,'paths':sitemap,'replaced':sorted(REPLACED),'summary':summary})
    print({k:v for k,v in summary.items() if k not in ('errors','redirects')}, 'errors:',len(summary['errors']),flush=True)

if __name__ == '__main__':
    robots_raw, _ = get(ORIGIN + '/robots.txt')
    ROBOTS = RobotFileParser()
    ROBOTS.parse(robots_raw.decode().splitlines())
    main, _ = get(ORIGIN + '/sitemap.606978.xml.gz')
    extra, _ = get(ORIGIN + '/x/sitemap.xml')
    sitemap = list(dict.fromkeys(site_paths(gzip.decompress(main)) + site_paths(extra)))
    tags = [path for path in sitemap if path.startswith('/magazin/tag/')]
    product = [path for path in sitemap if path.startswith('/magazin/product/')]
    folder = [path for path in sitemap if path.startswith('/magazin/folder/')]
    paths = list(dict.fromkeys([*PRIORITY, *product, *folder, *[p for p in sitemap if p not in tags and p not in REPLACED]]))
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        for index,result in enumerate(executor.map(build,paths),1):
            results.append(result)
            if index == 40 or index % 100 == 0:
                print('Processed', index, '/', len(paths), flush=True)
                write_snapshot(results,sitemap,tags)
    write_snapshot(results,sitemap,tags)
