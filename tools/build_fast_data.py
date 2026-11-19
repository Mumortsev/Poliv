"""Build small browser indexes and catalog thumbnails from the migration snapshot."""
from collections import defaultdict
from hashlib import sha256
import json
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode, urlsplit

from lxml import html

from PIL import Image

site = Path('site')
data = site / 'data'
thumbs = site / 'catalog-thumbs'
thumbs.mkdir(exist_ok=True)
source = json.loads((data / 'index.json').read_text(encoding='utf-8'))

def write(name, content):
    (data / name).write_text(json.dumps(content, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

groups = defaultdict(list)
paths = {}
members = defaultdict(list)
for item in source['items']:
    entry = dict(item)
    paths[entry['path']] = entry['title']
    if entry['type'] == 'product':
        for breadcrumb in entry['breadcrumb']:
            members[breadcrumb].append(entry['path'])
    image = entry.get('image', '')
    if image.startswith('catalog-assets/'):
        name = sha256(image.encode()).hexdigest()[:16] + '.webp'
        target = thumbs / name
        if not target.exists():
            with Image.open(site / image) as photo:
                photo.thumbnail((360, 280), Image.Resampling.LANCZOS)
                photo.save(target, 'WEBP', quality=77, method=4)
        entry['image'] = target.relative_to(site).as_posix()
        with Image.open(target) as photo:
            entry['imageSize'] = photo.size
    groups[entry['type']].append(entry)
for group, entries in groups.items():
    write(f'list-{group}.json', {'imported': source['summary']['imported'], 'items': entries})
def resolve(href):
    if not href:
        return None
    parsed = urlsplit(href)
    if parsed.path == 'material.html' and not parsed.netloc:
        return parse_qs(parsed.query).get('p', [None])[0]
    if parsed.hostname != urlsplit(source['summary']['source']).hostname:
        return None
    target = unquote(parsed.path)
    return target if target in paths else None

for shard in sorted(data.glob('records-*.json')):
    records = json.loads(shard.read_text(encoding='utf-8'))
    for path, item in records.items():
        fragment = html.fragment_fromstring(item.get('content',''), create_parent='div')
        migrated = set()
        changed = False
        for link in fragment.xpath('.//a[@href]'):
            target = resolve(link.get('href'))
            if target and target in paths:
                current = 'material.html?' + urlencode({'p':target})
                if link.get('href') != current:
                    link.set('href', current)
                    changed = True
                migrated.add(target)
        if changed:
            from html import escape
            item['content'] = escape(fragment.text or '') + ''.join(
                html.tostring(node, encoding='unicode') for node in fragment)
        linked = set(filter(None,(resolve(link) for link in item.get('links', []))))
        if item['type'] == 'category':
            linked.update(members[item['title']])
        item['related'] = [[target, paths[target]] for target in sorted(linked - migrated - {path}) if target in paths]
    write(shard.name, records)
(data / 'paths.json').unlink(missing_ok=True)
