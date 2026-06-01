(function () {
  var dropdown = document.querySelector('.nav-dropdown');
  var btn = document.querySelector('.nav-dropdown-btn');
  if (!dropdown || !btn) return;

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  document.addEventListener('click', function () {
    dropdown.classList.remove('open');
  });

  // Close when a menu item is tapped
  var items = dropdown.querySelectorAll('.nav-dropdown-item');
  items.forEach(function (item) {
    item.addEventListener('click', function () {
      dropdown.classList.remove('open');
    });
  });
}());
