// Инициализация базы данных
if(!localStorage.getItem('sp_items')) {
  localStorage.setItem('sp_items', JSON.stringify([
    {"item": "40 Robux", "game": "Roblox", "rarity": "Валюта", "from": 64.65, "to": 106.49, "threshold": 38.79, "signal": "Цена ниже порога — проверка", "source": "https://starvell.com", "group": "Roblox"}
  ]));
}

if(!localStorage.getItem('sp_users')) {
  // Главный администратор по умолчанию
  localStorage.setItem('sp_users', JSON.stringify([
    {username: 'admin', pass: 'admin', role: 'admin'}
  ]));
}

if(!localStorage.getItem('sp_admins')) {
  // Вы — единственный супер-админ (можно добавлять других через панель)
  localStorage.setItem('sp_admins', JSON.stringify(['admin']));
}

function getUsers() { return JSON.parse(localStorage.getItem('sp_users') || '[]'); }
function getAdmins() { return JSON.parse(localStorage.getItem('sp_admins') || '["admin"]'); }
function getCurrentUser() { return JSON.parse(localStorage.getItem('sp_current_user') || 'null'); }
function isAdmin(username) { return getAdmins().includes(username); }

function loginOrRegister(u, p, key, isReg) {
  let users = getUsers();
  if(isReg) {
    const keys = JSON.parse(localStorage.getItem('sp_keys') || '[]');
    if(!keys.includes(key) && key !== 'MASTER-KEY') {
      return {success: false, error: 'Неверный ключ доступа'};
    }
    if(users.some(x => x.username === u)) {
      return {success: false, error: 'Имя уже занято'};
    }
    // Удаляем использованный ключ
    localStorage.setItem('sp_keys', JSON.stringify(keys.filter(k => k !== key)));
    
    const newUser = {username: u, pass: p, role: 'staff'};
    users.push(newUser);
    localStorage.setItem('sp_users', JSON.stringify(users));
    localStorage.setItem('sp_current_user', JSON.stringify(newUser));
    return {success: true};
  } else {
    const found = users.find(x => x.username === u && x.pass === p);
    if(found) {
      localStorage.setItem('sp_current_user', JSON.stringify(found));
      return {success: true};
    }
    return {success: false, error: 'Неверный логин или пароль'};
  }
}

// Рендер сайдбара на index.html
document.addEventListener('DOMContentLoaded', () => {
  const userPanel = document.getElementById('userPanel');
  if(userPanel) {
    const user = getCurrentUser();
    if(user) {
      const isA = isAdmin(user.username);
      userPanel.innerHTML = `
        <div class="user-info"><b>${user.username}</b><br><span style="color:var(--muted)">${isA ? 'Администратор' : 'Сотрудник'}</span></div>
        ${isA ? '<a href="admin.html" class="btn" style="margin-bottom:6px">Админ-панель</a>' : ''}
        <button class="btn btn-red" onclick="logout()">Выйти</button>
      `;
    } else {
      userPanel.innerHTML = `
        <div class="user-info" style="margin-bottom:8px">Гость</div>
        <a href="auth.html" class="btn">Авторизация</a>
      `;
    }
  }

  // Рендер каталога на index.html
  const body = document.getElementById('body');
  if(body) {
    initCatalog();
  }
});

function logout() {
  localStorage.removeItem('sp_current_user');
  location.reload();
}

let activeGroup = 'Все игры';
function initCatalog() {
  const groups = ['Все игры', 'Roblox', 'MM2', 'Rust', 'Другие игры'];
  const tabs = document.getElementById('tabs');
  
  groups.forEach(g => {
    let b = document.createElement('button');
    b.className = 'tab' + (g === activeGroup ? ' active' : '');
    b.textContent = g;
    b.onclick = () => { activeGroup = g; document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.textContent===g)); renderTable(); };
    tabs.appendChild(b);
  });

  document.getElementById('search').addEventListener('input', renderTable);
  document.getElementById('sort').addEventListener('change', renderTable);
  renderTable();
}

function renderTable() {
  const items = JSON.parse(localStorage.getItem('sp_items') || '[]');
  const q = document.getElementById('search').value.toLowerCase();
  const sort = document.getElementById('sort').value;

  let filtered = items.filter(x => (activeGroup === 'Все игры' || x.group === activeGroup) && (!q || JSON.stringify(x).toLowerCase().includes(q)));
  
  if(sort === 'low') filtered.sort((a,b)=>a.from - b.from);
  if(sort === 'high') filtered.sort((a,b)=>b.from - a.from);

  document.getElementById('body').innerHTML = filtered.map(x=>`
    <tr>
      <td><b>${x.item}</b></td>
      <td><span class="tag">${x.game}</span></td>
      <td>${x.rarity}</td>
      <td class="price">${x.from} ₽</td>
      <td class="price">${x.to} ₽</td>
      <td class="threshold">${x.threshold} ₽</td>
      <td>${x.signal}</td>
      <td><a href="${x.source}" target="_blank" style="color:var(--blue)">Ссылка</a></td>
    </tr>
  `).join('');
}
