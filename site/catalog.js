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

const dataRequests = new Map();
async function dataFile(name) {
  if (!dataRequests.has(name)) {
    const request = fetch('data/' + name + '.json').then(response => {
      if (!response.ok) throw new Error('Данные каталога недоступны');
      return response.json();
    }).catch(error => {
      dataRequests.delete(name);
      throw error;
    });
    dataRequests.set(name, request);
  }
  return dataRequests.get(name);
}

function listOf(type) {
  return dataFile('list-' + type);
}

function card(item) {
  const article = element('article', '', 'directory-card');
  if (item.image) {
    const image = element('img');
    image.src = item.image;
    image.alt = item.title;
    image.loading = 'lazy';
    image.decoding = 'async';
    if (item.imageSize) [image.width, image.height] = item.imageSize;
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
  const requested = params.get('type');
  const pageSize = 12;
  let type = Object.hasOwn(types, requested) ? requested : 'product';
  let revision = 0;
  let visibleCount = 0;
  let matches = [];
  let productCategoriesLoaded = false;
  let selectedCategory = params.get('category') ?? '';
  const searchText = new WeakMap();
  search.value = params.get('q') ?? '';

  function queryText(item) {
    if (!searchText.has(item)) {
      const text = [item.title, item.sku, item.vendor, item.summary, ...item.breadcrumb, ...(item.tags ?? [])];
      searchText.set(item, normalize(text.join(' ')));
    }
    return searchText.get(item);
  }

  function appendCards() {
    const next = matches.slice(visibleCount, visibleCount + pageSize);
    target.append(...next.map(card));
    visibleCount += next.length;
    more.hidden = matches.length <= visibleCount;
    status.textContent = matches.length ? `Найдено: ${matches.length}. Показано: ${visibleCount}.` : 'По этому запросу ничего не найдено.';
  }

  async function render() {
    const current = ++revision;
    const selectedType = type;
    const query = normalize(search.value).split(/\s+/).filter(Boolean);
    category.parentElement.hidden = selectedType !== 'product';
    buttons.forEach(button => button.setAttribute('aria-pressed', button.dataset.type === selectedType));
    const context = new URLSearchParams({ type: selectedType });
    if (search.value.trim()) context.set('q', search.value.trim());
    if (selectedType === 'product' && selectedCategory) context.set('category', selectedCategory);
    history.replaceState(null, '', '?' + context);
    more.hidden = true;
    status.textContent = 'Загружаем каталог…';
    try {
      const datasets = selectedType === 'all'
        ? await Promise.all(['product', 'category', 'article', 'page'].map(listOf))
        : [await listOf(selectedType)];
      if (revision !== current) return;
      const items = datasets.flatMap(group => group.items);
      if (selectedType === 'product' && !productCategoriesLoaded) {
        const names = [...new Set(items.map(categoryName).filter(Boolean))].sort((a,b) => a.localeCompare(b,'ru'));
        for (const name of names) category.add(new Option(name, name));
        category.value = selectedCategory;
        productCategoriesLoaded = true;
      }
      matches = items.filter(item => (
        (selectedType !== 'product' || !selectedCategory || categoryName(item) === selectedCategory) &&
        query.every(part => queryText(item).includes(part))
      ));
      document.querySelector('#directory-date').textContent = 'Обновление открытого каталога: ' +
        new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(datasets[0].imported)) + '.';
      target.replaceChildren();
      visibleCount = 0;
      appendCards();
    } catch (error) {
      if (revision !== current) return;
      target.replaceChildren();
      status.textContent = error.message;
    }
  }

  document.querySelector('#directory-search').addEventListener('submit', event => { event.preventDefault(); render(); });
  search.addEventListener('search', render);
  category.addEventListener('change', () => { selectedCategory = category.value; render(); });
  buttons.forEach(button => button.addEventListener('click', () => { type = button.dataset.type; render(); }));
  more.addEventListener('click', appendCards);
  await render();
}

function recordGroup(path) {
  let value = 0;
  for (const char of path) value = (value + char.codePointAt(0)) % 24;
  return 'records-' + String(value).padStart(2, '0');
}

async function showMaterial() {
  const path = params.get('p');
  if (!path?.startsWith('/') || path.startsWith('//')) throw new Error('Выберите страницу в каталоге.');
  const records = await dataFile(recordGroup(path));
  const item = records[path];
  if (!item) throw new Error('Эту страницу можно открыть на действующем сайте.');
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
      image.decoding = 'async';
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
  document.querySelector('#material-status').hidden = true;
  document.querySelector('#material-article').hidden = false;
  for (const [target, label] of item.related ?? []) {
    const entry = element('li');
    const link = element('a', label);
    link.href = detailUrl(target);
    entry.append(link);
    document.querySelector('#material-links').append(entry);
  }
}

const directory = document.querySelector('#directory');
(directory ? showDirectory() : showMaterial()).catch(error => {
  const status = document.querySelector(directory ? '#directory-status' : '#material-status');
  status.textContent = error.message;
  const link = element('a', ' Открыть Технополив.рф ↗');
  link.href = 'https://технополив.рф/katalog';
  status.append(link);
});
