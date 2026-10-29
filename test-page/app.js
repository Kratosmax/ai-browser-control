let count = 0;
const status = document.getElementById('visibility');
function updateVisibility() { status.textContent = document.visibilityState; }
updateVisibility();
document.addEventListener('visibilitychange', updateVisibility);
document.getElementById('record').addEventListener('click', () => {
  document.getElementById('count').textContent = String(++count);
  document.getElementById('saved').textContent = document.getElementById('test-input').value || '（空）';
});
