const form = document.querySelector('#quote-form');
const filterButtons = document.querySelectorAll('[data-filter]');
const products = document.querySelectorAll('[data-category]');
const message = document.querySelector('.status');
const phone = document.querySelector('#demo-phone');

filterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    filterButtons.forEach((item) => item.setAttribute('aria-pressed', item === button));
    products.forEach((product) => {
      product.hidden = button.dataset.filter !== 'all' && button.dataset.filter !== product.dataset.category;
    });
  });
});

document.querySelectorAll('[data-type], [data-request]').forEach((link) => {
  link.addEventListener('click', () => {
    form.elements.request.value = link.dataset.request || 'Расчёт системы';
    if (link.dataset.type) form.elements.type.value = link.dataset.type;
    if (link.dataset.detail) form.elements.detail.value = link.dataset.detail;
    message.hidden = true;
  });
});

form.addEventListener('input', () => { message.hidden = true; });
phone.addEventListener('input', () => { phone.setCustomValidity(''); });
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const digits = phone.value.replace(/\D/g, '');
  if (!/^[+\d() -]+$/.test(phone.value) || digits.length < 10 || digits.length > 15) {
    phone.setCustomValidity('Введите номер телефона с 10–15 цифрами.');
    phone.reportValidity();
    return;
  }
  message.textContent = 'Демо-заявка заполнена. На новом сайте она поступит менеджеру после подключения формы.';
  message.hidden = false;
});

form.querySelector('button').disabled = false;
