(() => {
  'use strict';

  const header = document.getElementById('header');
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
