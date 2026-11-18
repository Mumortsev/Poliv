"""Mirror public Technopoliv images and update the generated catalog data."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser

from lxml import html
from PIL import Image, ImageOps

ORIGIN = 'https://xn--b1afjljgahx5a.xn--p1ai'
AGENT = 'TechnopolivPublicMigration/1.0'
SITE = Path('site')
DATA = SITE / 'data'
ASSETS = SITE / 'catalog-assets'
ASSETS.mkdir(parents=True,exist_ok=True)
ROBOTS = RobotFileParser()
with urlopen(Request(ORIGIN + '/robots.txt', headers={'User-Agent':AGENT}),timeout=12) as file:
    ROBOTS.parse(file.read().decode().splitlines())

def download(url):
    name = 'catalog-assets/' + sha256(url.encode()).hexdigest()[:20] + '.webp'
    target = SITE / name
    if target.exists():
        return url, name, None
    if not ROBOTS.can_fetch(AGENT, url):
        return url, None, 'robots'
    try:
        with urlopen(Request(url, headers={'User-Agent':AGENT, 'Accept':'image/*'}), timeout=14) as file:
            if urlsplit(file.geturl()).hostname != urlsplit(ORIGIN).hostname:
                return url, None, 'external_redirect'
            data = file.read(18_000_001)
        if len(data) > 18_000_000:
            return url, None, 'size'
        with Image.open(BytesIO(data)) as source:
            if getattr(source,'is_animated',False):
                return url, None, 'animated_original'
            image = ImageOps.exif_transpose(source)
            image.thumbnail((1440,1440),Image.Resampling.LANCZOS)
            if image.mode not in ('RGB','RGBA'):
                image = image.convert('RGBA' if 'transparency' in image.info else 'RGB')
            image.save(target,'WEBP',quality=87,method=4)
        return url, name, None
    except HTTPError as error:
        return url, None, str(error.code)
    except (OSError, ValueError):
        return url, None, 'unavailable'

def page_images(content):
    root = html.fragment_fromstring(content,create_parent='div')
    return root, root.xpath('.//img[@src]')

def save(path, data):
    path.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')

records = {}
images = set()
for path in sorted(DATA.glob('records-*.json')):
    records[path] = json.loads(path.read_text())
    for item in records[path].values():
        root, nodes = page_images(item.get('content',''))
        images.update(item.get('images', []))
        images.update(node.get('src') for node in nodes)
images = {url for url in images if url and urlsplit(url).hostname == urlsplit(ORIGIN).hostname}
assets = {}
failures = []
with ThreadPoolExecutor(max_workers=5) as worker:
    for index,(url,path,error) in enumerate(worker.map(download,sorted(images)),1):
        if path: assets[url] = path
        else: failures.append({'url':url,'error':error})
        if index % 100 == 0: print('Processed images', index, '/', len(images), flush=True)

for path,record in records.items():
    for item in record.values():
        item['images'] = [assets.get(url,url) for url in item.get('images',[])]
        content = item.get('content','')
        if not content: continue
        root,nodes = page_images(content)
        changed = False
        for node in nodes:
            asset = assets.get(node.get('src'))
            if asset:
                node.set('src',asset)
                changed = True
        if changed:
            item['content'] = (root.text or '') + ''.join(html.tostring(node,encoding='unicode') for node in root)
    save(path,record)

for filename in ('index.json','source-index.json'):
    target = DATA / filename
    data = json.loads(target.read_text())
    data['summary']['imagesCopied'] = len(assets)
    data['summary']['imagesUnavailable'] = len(failures)
    for item in data.get('items',[]):
        if item.get('image'): item['image'] = assets.get(item['image'],item['image'])
    save(target,data)
save(DATA / 'image-index.json', {'sourceToLocal':assets,'unavailable':failures})
print('Mirrored',len(assets),'of',len(images),'images',flush=True)
