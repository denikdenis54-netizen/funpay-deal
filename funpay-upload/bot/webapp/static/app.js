/* FunPay Deal — логика Mini App */
(() => {
  'use strict';

  const tg = window.Telegram?.WebApp || null;

  const state = {
    user: null,
    config: null,
    balances: {},
    tab: 'deals',
    flow: { step: 0, side: 'buy', currency: 'RUB', payMethod: '', title: '', amount: '', requisites: '' },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  let pollTimer = null;

  // ---------- Утилиты ----------
  const haptic = (type = 'light') => {
    try { tg?.HapticFeedback?.impactOccurred(type); } catch (_) {}
  };
  const notify = (type = 'light') => {
    try { tg?.HapticFeedback?.notificationOccurred(type); } catch (_) {}
  };

  function money(amount, currency) {
    // Формат как в референсном интерфейсе: 12312.00 RUB (без разделителей разрядов)
    return `${(Number(amount) || 0).toFixed(2)} ${currency}`;
  }

  function parseAmount(raw) {
    const value = String(raw || '').replace(/\s| /g, '').replace(',', '.');
    const num = Number(value);
    return Number.isFinite(num) ? num : NaN;
  }

  function dateLabel(ts) {
    const d = new Date((Number(ts) || 0) * 1000);
    if (!ts) return '—';
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  let toastTimer = null;
  function toast(text, ms = 2600) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------- API ----------
  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (tg?.initData) headers.Authorization = `tma ${tg.initData}`;

    // В браузере при DEV_MODE пробрасываем user_id, чтобы можно было
    // проверить сделку глазами второй стороны. В Telegram не действует.
    let url = path;
    const devUser = new URLSearchParams(location.search).get('user_id');
    if (devUser && !tg?.initData) {
      url += (url.includes('?') ? '&' : '?') + 'user_id=' + encodeURIComponent(devUser);
    }

    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { ...headers, ...(options.headers || {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (_) {
      throw new Error('Нет связи с сервером');
    }

    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `Ошибка ${response.status}`);
    }
    return data;
  }

  // ---------- Навигация ----------
  const SCREENS = {
    deals: '#screen-deals',
    list: '#screen-list',
    deal: '#screen-deal',
    reviews: '#screen-reviews',
    wallets: '#screen-wallets',
    leaders: '#screen-leaders',
    profile: '#screen-profile',
  };

  function showScreen(name) {
    $$('.screen').forEach((s) => s.classList.remove('is-active'));
    const el = $(SCREENS[name]);
    if (el) el.classList.add('is-active');
    window.scrollTo({ top: 0 });

    if (name !== 'deals') {
      tg?.BackButton?.show();
    } else {
      tg?.BackButton?.hide();
    }
    // Уходя с экрана сделки, останавливаем опрос
    if (name !== 'deal' && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    state.screen = name;
  }

  function showTab(name) {
    state.tab = name;
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));

    if (name === 'deals') showScreen('deals');
    if (name === 'wallets') { showScreen('wallets'); loadWallets(); }
    if (name === 'leaders') { showScreen('leaders'); loadLeaders(); }
    if (name === 'profile') { showScreen('profile'); loadProfile(); }
  }

  // ---------- Экраны: списки ----------
  async function loadDeals(scope, title) {
    $('#listTitle').textContent = title;
    $('#listSubtitle').textContent =
      scope === 'history' ? 'Завершённые сделки FunPay' : 'Текущие сделки FunPay';
    const list = $('#dealList');
    list.innerHTML = '<div class="empty">Загружаю…</div>';
    showScreen('list');

    try {
      const { deals } = await api(`/api/deals?scope=${encodeURIComponent(scope)}`);
      if (!deals.length) {
        list.innerHTML = `<div class="empty">${scope === 'history'
          ? 'Завершённых сделок пока нет'
          : 'Активных сделок нет. Создай первую!'}</div>`;
        return;
      }
      list.innerHTML = scope === 'history'
        ? deals.map(historyRow).join('')
        : deals.map(dealCard).join('');

      if (scope !== 'history') {
        $$('.list-item', list).forEach((node) => {
          node.addEventListener('click', () => openDeal(Number(node.dataset.id)));
        });
      } else {
        $$('.hist-row', list).forEach((node, i) => {
          node.style.cursor = 'pointer';
          node.addEventListener('click', () => openDeal(deals[i].id));
        });
      }
    } catch (err) {
      list.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  function dealCard(deal) {
    const role = deal.user_role === 'buyer' ? 'Покупатель' : 'Продавец';
    const done = deal.status === 'completed';
    const cancelled = deal.status === 'cancelled';
    const badge = cancelled ? 'is-cancel' : done ? 'is-done' : 'is-active';
    return `
      <button class="list-item" data-id="${deal.id}">
        <div class="row">
          <span class="amount">${escapeHtml(money(deal.amount, deal.currency))}</span>
          <span class="badge ${badge}">${escapeHtml(done ? 'Завершена' : cancelled ? 'Отменена' : deal.status_title)}</span>
        </div>
        <div class="row muted"><span>${escapeHtml(deal.title)}</span></div>
        <div class="row muted"><span>Ваша роль: ${role}</span><span>${dateLabel(deal.created_at)}</span></div>
      </button>`;
  }

  async function openDealByCode(code) {
    const view = $('#dealView');
    view.innerHTML = '<div class="empty">Открываю сделку…</div>';
    showScreen('deal');
    try {
      const { deal, balance, share_url } = await api(`/api/deals/code/${encodeURIComponent(code)}`);
      renderDeal(deal, balance, share_url);
      pollIfWaiting(deal);
    } catch (err) {
      view.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  // Экран держится в актуальном состоянии: опрашиваем, пока сделка открыта,
  // иначе после оплаты/передачи стороны не видят действия друг друга
  function pollIfWaiting(deal) {
    if (pollTimer) clearInterval(pollTimer);
    if (deal.status === 'cancelled' || deal.status === 'completed') return;

    pollTimer = setInterval(async () => {
      try {
        const { deal: fresh, balance } = await api(`/api/deals/${deal.id}`);
        if (fresh.status !== deal.status) {
          renderDeal(fresh, balance);
          deal = fresh;
          if (fresh.status === 'paid') toast('Оплата прошла');
          if (fresh.status === 'delivered') toast('Подарок передан');
          if (fresh.status === 'completed') toast('Сделка завершена');
          if (fresh.status === 'cancelled' || fresh.status === 'completed') {
            clearInterval(pollTimer);
          }
        }
      } catch (_) {
        clearInterval(pollTimer);
      }
    }, 4000);
  }

  async function openDeal(dealId) {
    const view = $('#dealView');
    view.innerHTML = '<div class="empty">Загружаю…</div>';
    showScreen('deal');
    try {
      const { deal, balance, share_url } = await api(`/api/deals/${dealId}`);
      renderDeal(deal, balance, share_url);
      pollIfWaiting(deal);
    } catch (err) {
      view.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  function progressBlock(deal, stageNames) {
    const tags = stageNames || ['Создана', 'Продавец', 'Оплачена', 'Встреча', 'Получена'];
    const stage = Number(deal.stage) || 0;
    return `
      <div class="progress">
        <div class="progress-label">Статус сделки</div>
        <div class="progress-title">Шаг ${stage + 1} из 5 — ${escapeHtml(deal.status_title)}</div>
        <div class="steps-line">${tags.map((_, i) => `<i class="${i <= stage ? 'on' : ''}"></i>`).join('')}</div>
        <div class="step-tags">${tags.map((t, i) =>
          `<span class="${i < stage ? 'on' : i === stage ? 'now' : ''}">${escapeHtml(t)}</span>`).join('')}</div>
        <div class="step-note">безопасно через Telegram</div>
      </div>`;
  }

  function renderDeal(deal, balance, shareUrl) {
    const cur = deal.currency;
    const role = deal.user_role === 'buyer' ? 'Покупатель' : 'Продавец';
    const cpRole = deal.counterparty_role === 'buyer' ? 'Покупатель' : 'Продавец';
    const cancelled = deal.status === 'cancelled';
    const waitingJoin = deal.status === 'created' || deal.status === 'awaiting_counterparty';
    const isGuest = deal.is_participant === false;
    const ownerIsSeller = deal.owner_role === 'seller';
    const inviteRole = deal.invite_role || 'Покупатель';
    const actions = deal.actions || [];

    const actionButtons = actions.map((action) => {
      if (action === 'pay') {
        return `<button class="btn btn-primary" data-act="pay">Оплатить ${escapeHtml(money(deal.amount, cur))}</button>`;
      }
      if (action === 'deliver') {
        return `<button class="btn btn-primary" data-act="deliver">Я передал подарок банку</button>`;
      }
      if (action === 'confirm') {
        return `<button class="btn btn-primary" data-act="confirm">Подтвердить получение</button>`;
      }
      if (action === 'close') {
        return `<button class="btn btn-primary" data-act="close">Завершить сделку</button>`;
      }
      if (action === 'review') {
        return `<button class="btn btn-primary" data-act="review">Оставить отзыв</button>`;
      }
      return '';
    }).join('');

    const reqs = deal.requisites
      ? `<div class="kv"><span class="muted">Реквизиты</span><b>${escapeHtml(deal.requisites)}</b></div>`
      : '';

    // Шаг 2 подписан ролью владельца сделки: продавец или покупатель
    const stageNames = ['Создана', role, 'Оплачена', 'Встреча', 'Получена'];
    const curMeta = (state.currencies || []).find((c) => c.code === cur);

    $('#dealView').innerHTML = `
      <h1 class="deal-code">#${escapeHtml(deal.code)}</h1>
      ${cancelled ? '' : progressBlock(deal, stageNames)}

      <div class="card big-amount">
        <span class="cur" style="${curMeta ? `background:${curMeta.color}` : ''}">${escapeHtml(curMeta ? curMeta.icon : cur[0])}</span>
        <div>
          <div class="val">${escapeHtml(money(deal.amount, cur))}</div>
          <div class="muted">Оплата: ${escapeHtml(deal.pay_method_title || '—')}</div>
        </div>
      </div>

      <div class="card">
        <div class="kv"><span class="muted">Статус</span><b>${escapeHtml(deal.status_title)}</b></div>
        <div class="kv"><span class="muted">Продавец</span><b>${
          deal.seller_name
            ? '@' + escapeHtml(deal.seller_name)
            : ownerIsSeller
              ? (deal.is_owner ? 'Вы' : 'Продавец (создатель сделки)')
              : 'Продавец ещё не присоединился'
        }</b></div>
        <div class="kv"><span class="muted">Покупатель</span><b>${
          deal.buyer_name
            ? '@' + escapeHtml(deal.buyer_name)
            : ownerIsSeller
              ? 'Покупатель ещё не присоединился'
              : (deal.is_owner ? 'Вы' : 'Покупатель (создатель сделки)')
        }</b></div>
        <div class="kv"><span class="muted">Создана</span><b>${dateLabel(deal.created_at)}</b></div>
        ${reqs}
      </div>

      <div class="now"><b>Сейчас</b><p>${
        isGuest
          ? `Вас пригласили в сделку. Присоединитесь как ${escapeHtml(inviteRole)}, чтобы продолжить.`
          : `${escapeHtml(deal.headline)}. ${escapeHtml(deal.detail)}`
      }</p></div>

      <div class="stack">
        ${isGuest && waitingJoin ? `
        <button class="btn btn-primary" data-act="join">Присоединиться как ${escapeHtml(inviteRole)}</button>` : ''}
        ${waitingJoin ? `
        <button class="btn btn-primary" data-act="share">Поделиться сделкой</button>
        <button class="btn" data-act="forward">Переслать ссылку</button>` : ''}
        ${actionButtons}
        <button class="btn" data-act="manager">Написать менеджеру</button>
        <button class="btn" data-act="safety">⚠ Безопасность сделки</button>
        ${cancelled || deal.status === 'completed' || isGuest ? '' : '<button class="btn" data-act="cancel">Отменить сделку</button>'}
      </div>

      <p class="foot">Баланс кошелька: ${escapeHtml(money(balance ?? 0, cur))}</p>`;

    $$('#dealView [data-act]').forEach((btn) => {
      btn.addEventListener('click', () => onDealAction(btn.dataset.act, deal, shareUrl));
    });
  }

  async function onDealAction(action, deal, shareUrl) {
    try {
      if (action === 'manager') { openManager(); return; }
      if (action === 'safety') { openSafety(); return; }

      if (action === 'share' || action === 'forward') {
        const url = shareUrl || '';
        // Telegram сам подставит ссылку из параметра url — если ещё
        // и первой строкой текста, она приходит в сообщении дважды.
        const text = [
          `FunPay — сделка #${deal.code}`,
          money(deal.amount, deal.currency),
          deal.title,
        ].join('\n');

        if (tg?.openTelegramLink) {
          tg.openTelegramLink(
            `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`
          );
        } else if (navigator.clipboard) {
          // В буфер кладём полный текст: пересылать его будут без Telegram.
          await navigator.clipboard.writeText([url, text].join('\n'));
          toast('Скопировано');
        } else {
          toast([url, text].join('\n'));
        }
        return;
      }

      if (action === 'review') {
        const text = prompt('Оставь отзыв о сделке');
        if (text === null) return;
        await api(`/api/deals/${deal.id}/review`, { method: 'POST', body: { text } });
        notify('success');
        toast('Спасибо за отзыв!');
        await openDeal(deal.id);
        return;
      }

      if (action === 'join') {
        try {
          const username = tg?.initDataUnsafe?.user?.username || '';
          await api(`/api/deals/${deal.id}/join`, {
            method: 'POST',
            body: { username },
          });
          notify('success');
          toast('Ты присоединился к сделке');
          await openDeal(deal.id);
        } catch (err) {
          notify('error');
          toast(err.message);
        }
        return;
      }

      if (action === 'cancel') {
        if (!confirm('Отменить сделку? Если деньги уже в эскроу, они вернутся покупателю.')) return;
        await api(`/api/deals/${deal.id}/cancel`, { method: 'POST' });
        notify('success');
        toast('Сделка отменена');
        await openDeal(deal.id);
        return;
      }

      if (action === 'pay') {
        await api(`/api/deals/${deal.id}/pay`, { method: 'POST' });
        notify('success');
        toast('Средства заморожены в эскроу');
        await openDeal(deal.id);
        return;
      }

      await api(`/api/deals/${deal.id}/${action}`, { method: 'POST' });
      notify('success');
      toast(
        action === 'deliver' ? 'Отправка подтверждена' : 'Сделка завершена'
      );
      await openDeal(deal.id);
    } catch (err) {
      notify('error');
      toast(err.message);
    }
  }

  function openManager() {
    const link = state.config?.manager_link;
    if (link) {
      if (tg?.openTelegramLink) tg.openTelegramLink(link);
      else window.open(link, '_blank');
    } else {
      toast('Менеджер пока не назначен — аккаунт будет указан позже');
    }
  }

  function openRequisites() {
    showTab('wallets');
  }

  function openSafety() {
    const text =
      '🛡 Безопасность сделки\n\n' +
      '• Средства идут на счёт FunPay и замораживаются в эскроу.\n' +
      '• Продавец получает деньги только после твоего подтверждения получения.\n' +
      '• Не отправляй товар, пока сделка не появилась в этом приложении.';
    if (tg?.showPopup) tg.showPopup({ title: 'Безопасность сделки', message: text, buttons: [{ type: 'ok' }] });
    else alert(text);
  }

  // ---------- Экранная клавиатура ----------
  // На телефоне position:fixed + bottom:0 не учитывает клавиатуру:
  // поле ввода и кнопка уезжают под неё, и написать текст невозможно.
  // Считаем перекрытие через visualViewport и поднимаем шторки.
  function bindKeyboard() {
    const vv = window.visualViewport;
    const apply = () => {
      if (!vv) return;
      // Ниже этого порога — не клавиатура, а адресная строка браузера
      const overlap = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      const kb = overlap > 100 ? Math.round(overlap) : 0;
      document.documentElement.style.setProperty('--kb', `${kb}px`);
      $$('.sheet').forEach((s) => {
        if (s.hidden) return;
        s.style.bottom = kb ? `${kb}px` : '';
      });
    };

    if (vv) {
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
    }
    // Telegram сообщает об изменении высоты вьюпорта отдельно
    tg?.onEvent?.('viewportChanged', apply);
    window.addEventListener('orientationchange', () => setTimeout(apply, 250));

    // Подкручиваем шторку к активному полю
    document.addEventListener('focusin', (e) => {
      if (e.target.matches?.('input, textarea, select')) {
        setTimeout(() => e.target.scrollIntoView?.({ block: 'center' }), 280);
      }
    });
    document.addEventListener('focusout', () => setTimeout(apply, 120));
  }

  // ---------- Создание сделки ----------
  const sheet = $('#createSheet');
  const overlay = $('#overlay');

  function openSheet(step = 0) {
    sheet.hidden = false;
    overlay.hidden = false;
    setStep(step);
  }

  function closeSheet() {
    sheet.hidden = true;
    overlay.hidden = true;
  }

  function setStep(step) {
    state.flow.step = step;
    $$('#createSteps .step').forEach((el) => {
      el.classList.toggle('is-active', Number(el.dataset.step) === step);
    });
    sheet.scrollTop = 0;
    haptic();
  }

  function renderCurrencies() {
    const box = $('#currencyChips');
    box.innerHTML = state.config.currencies.map((c) =>
      `<button class="chip" data-currency="${c.code}">${c.flag} ${c.code}</button>`).join('');
    $$('.chip', box).forEach((chip) => {
      chip.addEventListener('click', () => {
        state.flow.currency = chip.dataset.currency;
        $$('.chip', box).forEach((c) => c.classList.toggle('is-active', c === chip));
        renderPayMethods();
      });
    });
  }

  function renderPayMethods() {
    const currency = state.flow.currency;
    const select = $('#payMethod');
    const methods = (state.config.pay_methods || []).filter(
      (m) => m.currencies.includes('__any__') || m.currencies.includes(currency)
    );
    if (!methods.length) {
      select.innerHTML = '<option>—</option>';
      state.flow.payMethod = '';
      return;
    }
    select.innerHTML = methods.map((m) =>
      `<option value="${m.code}">${escapeHtml(m.title)}</option>`).join('');
    state.flow.payMethod = methods[0].code;
    select.value = state.flow.payMethod;
    updateRequisites();
  }

  const REQUISITES_METHODS = ['card_ru', 'card_ua', 'kaspi', 'card_kz', 'card_by', 'ton'];

  function updateRequisites() {
    const need = REQUISITES_METHODS.includes(state.flow.payMethod);
    $('#requisitesHint').hidden = !need;
    $('#requisitesLabel').hidden = !need;
    $('#requisitesInput').hidden = !need;
  }

  async function refreshSummary() {
    const flow = state.flow;
    $('#sumAmount').textContent = money(flow.amount || 0, flow.currency);
    $('#sumTitle').textContent = flow.title;
    const balance = state.balances[flow.currency] ?? 0;
    $('#sumBalance').textContent = money(balance, flow.currency);
    $('#payBtn').textContent = `Оплатить ${money(flow.amount || 0, flow.currency)}`;

    const buyer = flow.side === 'buy';
    if (buyer && balance + 1e-9 < Number(flow.amount || 0)) {
      $('#payBtn').textContent = `Пополнить баланс и оплатить`;
    }
  }

  function renderConfirmation() {
    const flow = state.flow;
    // Тип в этом шаге всегда «Покупка» — как в интерфейсе FunPay
    $('#cfmType').textContent = 'Покупка';
    $('#cfmAmount').textContent = money(parseAmount(flow.amount) || 0, flow.currency);
    $('#cfmTitle').textContent = flow.title;

    const link = state.config?.manager_link;
    $('#cfmManager').innerHTML = link
      ? `🔔 Менеджер: <a href="${link}" target="_blank" rel="noopener">@${link.replace('https://t.me/', '')}</a>`
      : '🔔 Менеджер не назначен';
  }

  async function submitDeal() {
    const flow = state.flow;
    if (REQUISITES_METHODS.includes(flow.payMethod) && (flow.requisites || '').trim().length < 4) {
      toast('Укажи реквизиты перед созданием сделки');
      return;
    }

    $('#payBtn').disabled = true;
    try {
      const { deal } = await api('/api/deals', {
        method: 'POST',
        body: {
          side: flow.side,
          title: flow.title,
          amount: parseAmount(flow.amount),
          currency: flow.currency,
          pay_method: flow.payMethod,
          requisites: flow.requisites,
        },
      });

      toast('Сделка сохранена на сервере, сделка работает');
      notify('success');
      closeSheet();
      await openDeal(deal.id);
    } catch (err) {
      notify('error');
      toast(err.message);
    } finally {
      $('#payBtn').disabled = false;
    }
  }

  // ---------- Кошельки / лидеры / отзывы / профиль ----------
  async function loadWallets() {
    const list = $('#walletList');
    list.innerHTML = '<div class="empty">Загружаю…</div>';
    try {
      const { balances, currencies, methods } = await api('/api/wallets');
      state.balances = balances;
      state.currencies = currencies;
      renderBalances(list);

      $('#topupCurrency').innerHTML = currencies.map((c) =>
        `<option value="${c.code}">${c.flag} ${c.code} — ${escapeHtml(c.title)}</option>`).join('');

      const quick = $('#topupQuick');
      quick.innerHTML = [100, 500, 1000, 5000].map((v) =>
        `<button class="chip" data-quick="${v}">${v}</button>`).join('');
      $$('.chip', quick).forEach((chip) => {
        chip.addEventListener('click', () => { $('#topupAmount').value = chip.dataset.quick; });
      });
    } catch (err) {
      list.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  async function doTopUp() {
    const currency = $('#topupCurrency').value;
    const amount = parseAmount($('#topupAmount').value);
    if (!Number.isFinite(amount) || amount <= 0) { toast('Укажи сумму больше нуля'); return; }
    try {
      await api('/api/wallets/topup', { method: 'POST', body: { currency, amount } });
      $('#topupAmount').value = '';
      notify('success');
      toast('Кошелёк пополнен');
      loadWallets();
    } catch (err) {
      notify('error');
      toast(err.message);
    }
  }

  async function loadLeaders() {
    const list = $('#leaderList');
    list.innerHTML = '<div class="empty">Загружаю…</div>';
    try {
      const { leaders } = await api('/api/leaders');
      if (!leaders.length) {
        list.innerHTML = '<div class="empty">Рейтинг пока пуст. Заверши первую сделку!</div>';
        return;
      }
      list.innerHTML = leaders.map((u, i) => `
        <div class="card">
          <div class="kv"><span>${i + 1}. ${escapeHtml(u.name)}</span><b>${u.deals} сделок</b></div>
        </div>`).join('');
    } catch (err) {
      list.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadReviews() {
    const list = $('#reviewList');
    list.innerHTML = '<div class="empty">Загружаю…</div>';
    try {
      const { reviews, rating } = await api('/api/reviews');
      $('#ratingNum').textContent = rating.count ? rating.rating.toFixed(1) : '—';
      $('#ratingStars').innerHTML = Array.from({ length: 5 }, (_, i) =>
        `<i class="${i < rating.stars ? 'on' : ''}">★</i>`).join('');

      if (!reviews.length) {
        list.innerHTML = '<div class="empty">Отзывов пока нет</div>';
        return;
      }
      list.innerHTML = reviews.map((r) => `
        <div class="card">
          <p style="margin:0 0 6px">${escapeHtml(r.text)}</p>
          <div class="muted" style="font-size:12px">
            ${dateLabel(r.created_at)}
          </div>
        </div>`).join('');
    } catch (err) {
      list.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  // ---------- Форма отзыва ----------
const reviewSheet = { dealId: null, score: 5 };

  async function openReviewForm(dealId) {
    let id = dealId;
    if (!id) {
      // Отзыв только по завершённой сделке
      const { deals } = await api('/api/deals?scope=history');
      const done = (deals || []).filter((d) => d.status === 'completed');
      if (!done.length) {
        toast('Отзыв можно оставить только по завершённой сделке');
        return;
      }
      id = done[0].id;
      reviewSheet.dealCode = done[0].code;
    }

    const { deal } = await api(`/api/deals/${id}`);
    reviewSheet.dealId = deal.id;
    $('#reviewDeal').textContent = `Сделка #${deal.code} · ${money(deal.amount, deal.currency)}`;
    $('#reviewText').value = '';
    $('#reviewSend').dataset.score = '5';
    renderStars();
    $('#reviewSheet').hidden = false;
    $('#reviewOverlay').hidden = false;
  }

  function renderStars() {
    const score = Number($('#reviewSend').dataset.score || 5);
    $('#reviewStars').innerHTML = [1, 2, 3, 4, 5].map((n) =>
      `<button type="button" class="star ${n <= score ? 'on' : ''}" data-star="${n}">★</button>`
    ).join('');
    $$('#reviewStars .star').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('#reviewSend').dataset.score = btn.dataset.star;
        renderStars();
      });
    });
  }

  function closeReviewForm() {
    $('#reviewSheet').hidden = true;
    $('#reviewOverlay').hidden = true;
  }

  async function submitReview() {
    const text = $('#reviewText').value.trim();
    const score = Number($('#reviewSend').dataset.score || 5);
    if (text.length < 3) { toast('Напишите пару слов об отзыве'); return; }
    $('#reviewSend').disabled = true;
    try {
      await api(`/api/deals/${reviewSheet.dealId}/review`, {
        method: 'POST',
        body: { text, score },
      });
      notify('success');
      toast('Спасибо за отзыв!');
      closeReviewForm();
      await loadReviews();
    } catch (err) {
      notify('error');
      toast(err.message);
    } finally {
      $('#reviewSend').disabled = false;
    }
  }

  function historyRow(deal) {
    const done = deal.status === 'completed';
    const mark = done ? '✓' : '✕';
    return `
      <div class="hist-row">
        <span class="hist-ok" style="${done ? '' : 'background:#feeceb;color:#d92d20'}">${mark}</span>
        <div class="hist-body">
          <div class="hist-title">${escapeHtml(deal.title)}</div>
          <div class="hist-meta">#${escapeHtml(deal.code)} · ${escapeHtml(deal.currency)} · ${escapeHtml(isoDate(deal.created_at))}</div>
        </div>
        <div class="hist-right">
          <div class="hist-amt">${money(deal.amount, deal.currency).replace(' ' + deal.currency, '')}</div>
          <span class="hist-badge">${done ? 'Завершена' : 'Отменена'}</span>
        </div>
      </div>`;
  }

  function isoDate(ts) {
    if (!ts) return '—';
    // Формат референса: 2026-10-08T19:46:35.689Z
    return new Date(Number(ts) * 1000).toISOString();
  }

  async function loadProfile() {
    try {
      const [{ deals }, { balances, currencies }] = await Promise.all([
        api('/api/deals?scope=all'),
        api('/api/wallets'),
      ]);
      state.balances = balances;
      state.currencies = currencies;
      renderBalances($('#balanceList'));

      const u = tg?.initDataUnsafe?.user;
      $('#profName').textContent = u
        ? [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Игрок'
        : 'Игрок';
      $('#profHandle').textContent = u?.username ? `@${u.username}` : '@player';
      state.dealCount = deals.length;
    } catch (err) {
      toast(err.message);
    }
  }

  function renderBalances(container) {
    if (!container) return;
    const hideZero = $('#hideZero')?.checked;
    container.innerHTML = state.currencies.map((c) => {
      const value = state.balances[c.code] ?? 0;
      const zero = Math.abs(value) < 0.005;
      return `
        <div class="balance-row${hideZero && zero ? ' is-hidden' : ''}" data-cur="${c.code}">
          <span class="balance-icon" style="background:${c.color || '#2b7cff'}">${escapeHtml(c.icon || c.code[0])}</span>
          <span class="balance-name">${escapeHtml(c.code)}</span>
          <span class="balance-val">${money(value, c.code).replace(' ' + c.code, '')}</span>
        </div>`;
    }).join('');
  }

  // ---------- Привязка событий ----------
  function bind() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => { haptic(); showTab(t.dataset.tab); }));

    $$('[data-tab]').forEach((el) => {
      if (el.classList.contains('tab')) return;
      el.addEventListener('click', () => {
        const scope = el.dataset.scope;
        if (scope === 'history') loadDeals('history', 'История сделок');
        else if (scope === 'active') loadDeals('active', 'Активные сделки');
        else if (el.dataset.tab === 'reviews') { showScreen('reviews'); loadReviews(); }
      });
    });

    $$('[data-open="type"]').forEach((el) => el.addEventListener('click', () => openSheet(0)));
    $$('[data-close-sheet]').forEach((el) => el.addEventListener('click', closeSheet));
    overlay.addEventListener('click', closeSheet);
    $$('[data-close-screen]').forEach((el) => el.addEventListener('click', () => showTab('deals')));
    $$('[data-back]').forEach((el) => el.addEventListener('click', () => setStep(state.flow.step - 1)));

    $$('[data-side]').forEach((el) => el.addEventListener('click', () => {
      state.flow.side = el.dataset.side;
      setStep(1);
    }));

    $('#toAmount').addEventListener('click', () => {
      const title = $('#titleInput').value.trim();
      if (title.length < 3) { toast('Опиши товар чуть подробнее'); return; }
      state.flow.title = title;
      setStep(2);
      refreshSummary();
    });

    $('#payMethod').addEventListener('change', (e) => {
      state.flow.payMethod = e.target.value;
      updateRequisites();
    });

    ['#titleInput', '#amountInput', '#requisitesInput'].forEach((sel) => {
      $(sel).addEventListener('input', (e) => {
        state.flow[{ '#titleInput': 'title', '#amountInput': 'amount', '#requisitesInput': 'requisites' }[sel]] = e.target.value;
        if (state.flow.step === 3) refreshSummary();
      });
    });

    $('#toPayment').addEventListener('click', () => {
      const amount = parseAmount(state.flow.amount);
      if (!Number.isFinite(amount) || amount <= 0) { toast('Укажи сумму больше нуля'); return; }
      // При продаже оплату вносит покупатель — показываем подтверждение
      if (state.flow.side === 'sell') {
        renderConfirmation();
        setStep(4);
      } else {
        setStep(3);
        refreshSummary();
      }
    });

    $('#confirmCreate').addEventListener('click', () => submitDeal());

    $('#payBtn').addEventListener('click', submitDeal);
    $('#topupBtn').addEventListener('click', doTopUp);
    $('#managerBtn').addEventListener('click', openManager);
    $('#safetyBtn')?.addEventListener('click', openSafety);
    $('#hideZero')?.addEventListener('change', () => renderBalances($('#balanceList')));
    $('#requisitesBtn')?.addEventListener('click', openRequisites);

    $('#txBtn')?.addEventListener('click', () => loadDeals('history', 'Транзакции'));
    $('#addReviewBtn')?.addEventListener('click', () => openReviewForm());
    $('#reviewClose')?.addEventListener('click', closeReviewForm);
    $('#reviewOverlay')?.addEventListener('click', closeReviewForm);
    $('#reviewSend')?.addEventListener('click', submitReview);
    $('#langBtn')?.addEventListener('click', () => {
      const msg = 'Русский — активный язык\nАнглийский — в разработке';
      if (tg?.showPopup) tg.showPopup({ title: 'Языки', message: msg, buttons: [{ type: 'ok' }] });
      else toast(msg);
    });

    tg?.BackButton?.onClick?.(() => showTab('deals'));
    tg?.enableClosingConfirmation?.();
  }

  // ---------- Старт ----------
  async function boot() {
    try { tg?.ready(); } catch (_) {}
    try {
      tg?.setHeaderColor?.('#f2f6ff');
      tg?.setBackgroundColor?.('#f2f6ff');
      tg?.expand?.();
    } catch (_) {}

    bind();
    bindKeyboard();

    try {
      state.config = await api('/api/config');
      state.currencies = state.config.currencies;
      state.user = await api('/api/register', { method: 'POST' });

      // Сначала рисуем то, без чего форма не работает
      renderCurrencies();
      $$('.chip[data-currency]')[0]?.classList.add('is-active');
      renderPayMethods();
      const { balances } = await api('/api/wallets');
      state.balances = balances;

      // Оформление — необязательные элементы, их отсутствие не должно ломать форму
      const note = $('#demoNote');
      if (note) note.hidden = !state.config.demo;

      const mgrBtn = $('#managerBtn');
      if (mgrBtn) {
        const mgr = state.config.manager_link
          ? state.config.manager_link.replace('https://t.me/', '')
          : null;
        mgrBtn.textContent = mgr ? `💬 Менеджер @${mgr}` : '💬 Менеджер не назначен';
      }
    } catch (err) {
      toast(err.message, 5000);
    }
    showTab('deals');

    // Deep link: t.me/<bot>?startapp=<КОД> открывает сделку сразу
    const deepLink =
      tg?.initDataUnsafe?.start_param ||
      new URLSearchParams(location.search).get('deal');
    if (deepLink) await openDealByCode(deepLink);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
