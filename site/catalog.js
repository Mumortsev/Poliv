const origin = 'https://xn--b1afjljgahx5a.xn--p1ai';
const params = new URLSearchParams(location.search);
const types = { product: 'Товар', category: 'Категория', article: 'Статья', page: 'Справочник', all: 'Все разделы' };
const normalize = value => String(value ?? '').toLocaleLowerCase('ru').replaceAll('ё', 'е').trim();

function detailUrl(path) {
  return 'material.html?' + new URLSearchParams({ p: path });
}

function originalUrl(path) {
  return origin + path.split('/').map(encodeURIComponent).join('/');
}

function element(tag, content = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}

async function dataFile(name) {
  const response = await fetch('data/' + name + '.json');
  if (!response.ok) throw new Error('Данные каталога недоступны');
  return response.json();
}

function card(item) {
  const article = element('article', '', 'directory-card');
  if (item.image) {
    const image = element('img');
    image.src = item.image;
    image.alt = item.title;
    image.loading = 'lazy';
    image.addEventListener('error', () => image.remove(), { once: true });
    article.append(image);
  }
  const text = element('div');
  const category = item.breadcrumb.at(-1) ?? types[item.type];
  text.append(element('p', category, 'directory-meta'));
  const heading = element('h2');
  const link = element('a', item.title);
  link.href = detailUrl(item.path);
  heading.append(link);
  text.append(heading);
  if (item.price) text.append(element('p', item.price));
  if (item.summary && item.type !== 'product') text.append(element('p', item.summary));
  article.append(text);
  return article;
}

function categoryName(item) {
  return item.breadcrumb[0] === 'Магазин' ? item.breadcrumb[1] : item.breadcrumb[0];
}

async function showDirectory() {
  const status = document.querySelector('#directory-status');
  const target = document.querySelector('#directory-results');
  const search = document.querySelector('#directory-query');
  const category = document.querySelector('#directory-category');
  const more = document.querySelector('#directory-more');
  const buttons = [...document.querySelectorAll('[data-type]')];
  const { summary, items } = await dataFile('index');
  const requested = params.get('type');
  let type = Object.hasOwn(types, requested) ? requested : 'product';
  let size = 24;
  search.value = params.get('q') ?? '';
  for (const name of [...new Set(items.filter(item => item.type === 'product').map(categoryName).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'ru'))) {
    category.add(new Option(name, name));
  }
  category.value = params.get('category') ?? '';
  document.querySelector('#directory-date').textContent =
    'Обновление открытого каталога: ' + new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(summary.imported)) + '.';

  function render() {
    const query = normalize(search.value).split(/\s+/).filter(Boolean);
    category.parentElement.hidden = type !== 'product';
    buttons.forEach(button => button.setAttribute('aria-pressed', button.dataset.type === type));
    const context = new URLSearchParams({ type });
    if (search.value.trim()) context.set('q', search.value.trim());
    if (type === 'product' && category.value) context.set('category', category.value);
    history.replaceState(null, '', '?' + context);
    const matches = items.filter(item => (
      (type === 'all' || item.type === type) &&
      (type !== 'product' || !category.value || categoryName(item) === category.value) &&
      query.every(part => normalize([item.title, item.sku, item.vendor, item.summary, ...item.breadcrumb, ...(item.tags ?? [])].join(' ')).includes(part))
    ));
    target.replaceChildren(...matches.slice(0, size).map(card));
    more.hidden = matches.length <= size;
    status.textContent = matches.length ? `Найдено: ${matches.length}. Показано: ${Math.min(size, matches.length)}.` : 'По этому запросу ничего не найдено.';
  }

  function reset() { size = 24; render(); }
  document.querySelector('#directory-search').addEventListener('submit', event => { event.preventDefault(); reset(); });
  search.addEventListener('search', reset);
  category.addEventListener('change', reset);
  buttons.forEach(button => button.addEventListener('click', () => { type = button.dataset.type; reset(); }));
  more.addEventListener('click', () => { size += 24; render(); });
  render();
}

function recordGroup(path) {
  let value = 0;
  for (const char of path) value = (value + char.codePointAt(0)) % 24;
  return 'records-' + String(value).padStart(2, '0');
}

async function showMaterial() {
  const path = params.get('p');
  if (!path?.startsWith('/') || path.startsWith('//')) throw new Error('Выберите страницу в каталоге.');
  const [{ items }, records] = await Promise.all([dataFile('index'), dataFile(recordGroup(path))]);
  const item = records[path];
  if (!item) throw new Error('Эту страницу можно открыть на действующем сайте.');
  const known = new Map(items.map(entry => [entry.path, entry]));
  const source = originalUrl(path);
  document.title = item.title + ' — Технополив';
  document.querySelector('#material-title').textContent = item.title;
  document.querySelector('#material-breadcrumb').textContent = item.breadcrumb.join(' / ');
  document.querySelector('#material-original').href = source;
  if (item.type === 'product') {
    document.querySelector('#material-product').hidden = false;
    document.querySelector('#material-price').textContent = item.price || 'Уточнить цену';
    document.querySelector('#material-buy').href = source;
    document.querySelector('#material-meta').textContent =
      [item.sku && 'Артикул ' + item.sku, item.vendor, item.status === 'Предзаказ' && item.status].filter(Boolean).join(' · ');
    for (const src of item.images) {
      const image = element('img');
      image.src = src;
      image.alt = item.title;
      image.loading = 'lazy';
      image.addEventListener('error', () => image.remove(), { once: true });
      document.querySelector('#material-images').append(image);
    }
  }
  const body = document.querySelector('#material-body');
  body.innerHTML = item.content;
  if (item.tags?.length) {
    const tags = document.querySelector('#material-tags');
    tags.hidden = false;
    for (const tag of item.tags) {
      const link = element('a', tag);
      link.href = 'catalog.html?' + new URLSearchParams({ type: 'product', q: tag });
      tags.append(link);
    }
  }
  const migrated = new Set();
  function resolve(href) {
    if (!href) return null;
    try {
      const url = new URL(href);
      const target = decodeURIComponent(url.pathname);
      return url.origin === origin && known.has(target) ? target : null;
    } catch {
      return null;
    }
  }
  for (const link of body.querySelectorAll('a[href]')) {
    const target = resolve(link.href);
    if (target) {
      link.href = detailUrl(target);
      migrated.add(target);
    }
  }
  const linked = new Set((item.links ?? []).map(resolve).filter(target => target && target !== path && !migrated.has(target)));
  if (item.type === 'category') {
    for (const product of items.filter(entry => entry.type === 'product' && entry.breadcrumb.includes(item.title))) {
      linked.add(product.path);
    }
  }
  for (const target of linked) {
    const entry = element('li');
    const link = element('a', known.get(target).title);
    link.href = detailUrl(target);
    entry.append(link);
    document.querySelector('#material-links').append(entry);
  }
  document.querySelector('#material-status').hidden = true;
  document.querySelector('#material-article').hidden = false;
}

const directory = document.querySelector('#directory');
(directory ? showDirectory() : showMaterial()).catch(error => {
  const status = document.querySelector(directory ? '#directory-status' : '#material-status');
  status.textContent = error.message;
  const link = element('a', ' Открыть Технополив.рф ↗');
  link.href = 'https://технополив.рф/katalog';
  status.append(link);
});
