(async () => {
  const send = async message => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'Расширение недоступно.');
    return result.value;
  };
  const log = event => send({type: 'diagnostic', event}).catch(() => {});
  let challenge;
  try { challenge = await send({type: 'challenge'}); } catch { return; }
  log('signer.loaded');
  if (challenge.automatic) {
    const waitFor = (check, timeout) => new Promise((resolve, reject) => {
      const end = Date.now() + timeout;
      let timer;
      const observer = new MutationObserver(tick);
      function finish(error, value) { clearInterval(timer); observer.disconnect(); error ? reject(error) : resolve(value); }
      function tick() {
        try {
          const value = check();
          if (value) finish(null, value);
          else if (Date.now() >= end) finish(new Error('timeout'));
        } catch (error) { finish(error); }
      }
      observer.observe(document.documentElement, {childList: true, subtree: true, attributes: true});
      timer = setInterval(tick, 500); tick();
    });
    let reason = 'certificate';
    try {
      const selected = await waitFor(() => {
        const lists = document.getElementById('CertListBox') ? [document.getElementById('CertListBox')] : [...document.querySelectorAll('select')];
        for (const list of lists) {
          const option = [...list.options].find(option => !option.disabled && /✅/.test(option.textContent) && /труфанова\s+лариса/iu.test(option.textContent));
          if (option) return {list, option};
        }
        return null;
      }, 45000);
      log('signer.auto_selected');
      selected.list.selectedIndex = selected.option.index;
      selected.list.dispatchEvent(new Event('change', {bubbles: true}));
      reason = 'fields';
      const fields = await waitFor(() => {
        const data = document.getElementById('DataToSignTxtBox');
        const signature = document.getElementById('SignatureTxtBox');
        const button = [...document.querySelectorAll('button, input[type=button], input[type=submit]')].find(el => (el.value || el.textContent).trim() === 'Подписать' && !el.disabled);
        return data && signature && button ? {data, signature, button} : null;
      }, 20000);
      for (const checkbox of document.querySelectorAll('input[type=checkbox]')) {
        const labels = [...(checkbox.labels || [])].map(label => label.textContent).join(' ');
        const adjacent = checkbox.nextSibling?.textContent || '';
        const text = labels || adjacent + (checkbox.parentElement?.textContent.length < 180 ? checkbox.parentElement.textContent : '');
        if (/отдел[её]нная подпись|проверять подписанта/iu.test(text) && checkbox.checked) {
          checkbox.click();
          if (checkbox.checked) throw new Error('checkbox_not_cleared');
        }
      }
      fields.data.value = challenge.data;
      fields.data.dispatchEvent(new Event('input', {bubbles: true}));
      fields.data.dispatchEvent(new Event('change', {bubbles: true}));
      if ('value' in fields.signature) fields.signature.value = '';
      else fields.signature.textContent = '';
      reason = 'signature';
      log('signer.auto_signing');
      fields.button.click();
      const signature = await waitFor(() => {
        const value = fields.signature.value || fields.signature.textContent || '';
        return value.replace(/\s/g, '').length >= 40 ? value : null;
      }, 65000);
      if (fields.data.value !== challenge.data) throw new Error('data_changed');
      reason = 'signing';
      await send({type: 'signature', signature});
    } catch {
      await send({type: 'autoFailure', reason}).catch(() => {});
    }
    return;
  }
  const host = document.createElement('div');
  const shadow = host.attachShadow({mode: 'closed'});
  const panel = document.createElement('section');
  panel.style.cssText = 'background:#eef6ff;color:#18283c;padding:16px;border:2px solid #2563eb;font:15px sans-serif;max-width:900px;margin:16px auto;position:relative;z-index:2147483647';
  const title = document.createElement('strong'); title.textContent = 'КИЗ: подпись запроса авторизации';
  const instructions = document.createElement('p');
  instructions.textContent = '1. Выберите нужный действующий сертификат (например, Труфанова Лариса). 2. Подставьте данные кнопкой ниже. 3. Снимите флажки «Отделенная подпись» и «Проверять подписанта», нажмите штатную кнопку «Подписать». 4. После успешной подписи отправьте её в расширение.';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const data = document.createElement('textarea'); data.value = challenge.data; data.readOnly = true;
  data.style.cssText = 'display:block;width:95%;height:60px'; data.setAttribute('aria-label', 'Данные запроса авторизации');
  const fill = document.createElement('button'); fill.textContent = 'Подставить данные для подписи';
  fill.onclick = () => {
    const field = document.getElementById('DataToSignTxtBox');
    if (!field) { log('signer.field_missing'); status.textContent = 'Поле страницы не найдено. Скопируйте данные из блока выше вручную в «Данные для подписи».'; return; }
    log('signer.data_filled');
    field.value = challenge.data;
    field.dispatchEvent(new Event('input', {bubbles: true}));
    field.dispatchEvent(new Event('change', {bubbles: true}));
    status.textContent = 'Данные подставлены. Нажмите «Подписать» на странице КриптоПро.';
  };
  const submit = document.createElement('button'); submit.textContent = 'Передать готовую подпись в КИЗ';
  submit.onclick = async () => {
    const field = document.getElementById('SignatureTxtBox');
    const signature = field?.value || field?.textContent;
    if (!signature?.trim()) { log('signer.signature_missing'); status.textContent = 'Подпись не найдена. Скопируйте её в ручное поле на вкладке КИЗ.'; return; }
    submit.disabled = true;
    try { await send({type: 'signature', signature}); status.textContent = 'Авторизация успешна. Вернитесь на вкладку КИЗ.'; fill.disabled = true; }
    catch (e) { status.textContent = e.message; submit.disabled = false; }
  };
  panel.append(title, instructions, data, fill, document.createTextNode(' '), submit, status);
  shadow.append(panel); document.body.prepend(host);
})();
