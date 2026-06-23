(function () {
  const pages = [
    { href: 'index.html', label: 'Overview' },
    { href: 'doc1.html', label: 'Doc 1 — Data Models' },
    { href: 'doc2.html', label: 'Doc 2 — AWS Architecture' },
    { href: 'doc3.html', label: 'Doc 3 — Update Flow' },
    { href: 'flow.html', label: 'Flow Diagram' },
    { href: 'success_flow_illustration.html', label: 'Success Tables' },
    { href: 'failed_flow_illustration.html', label: 'Failure Tables' },
  ];

  const current = location.pathname.split('/').pop() || 'index.html';

  const nav = document.createElement('nav');
  nav.className = 'site-nav';

  const brand = document.createElement('a');
  brand.className = 'nav-brand';
  brand.href = 'index.html';
  brand.textContent = 'Walktru · Home Assignment';
  nav.appendChild(brand);

  pages.forEach(({ href, label }) => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    if (href === current) a.className = 'active';
    nav.appendChild(a);
  });

  document.body.prepend(nav);
})();
