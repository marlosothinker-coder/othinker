const root = document.getElementById('app');
const ASSISTANT_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT' };

let state = null;
let saveError = false;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

async function api(path, options = {}) {
  const token = await window.shopify.idToken();
  const response = await fetch(path, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}`);
  return response.json();
}

async function save() {
  const tools = Object.fromEntries(
    state.connectors.map((connector) => [connector.id, { uses: connector.uses, connected: connector.connected }]),
  );
  try {
    await api('/api/selections', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant: state.assistant, tools }),
    });
    saveError = false;
  } catch {
    saveError = true;
  }
  render();
}

// Saves run one at a time so a quick second click can't be overwritten by an older request.
let pendingSave = Promise.resolve();

function update(change) {
  change();
  render();
  pendingSave = pendingSave.then(save);
}

async function copyPrompt(text, button, textNode) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = 'Copy'), 1500);
  } catch {
    // Clipboard access can be refused inside the admin frame; select the text instead.
    window.getSelection().selectAllChildren(textNode);
  }
}

function checkbox(id, label, checked, onChange) {
  return el(
    'label',
    { class: 'check', for: id },
    el('input', { type: 'checkbox', id, checked, onchange: (event) => onChange(event.target.checked) }),
    label,
  );
}

function healthLine(health) {
  if (!health) return null;
  const date = new Date(health.checkedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return el(
    'p',
    { class: health.ok ? 'health ok' : 'health down' },
    health.ok ? `Connector is responding · checked ${date}` : `Connector is not responding · checked ${date}`,
  );
}

function connectorCard(connector) {
  const card = el(
    'section',
    { class: connector.connected ? 'card done' : 'card' },
    el(
      'header',
      {},
      el('h2', {}, connector.name),
      el('span', { class: 'tag' }, connector.category),
      connector.connected ? el('span', { class: 'tag connected' }, 'Connected') : null,
    ),
    el('p', { class: 'why' }, connector.why),
  );

  if (!connector.required) {
    card.append(
      checkbox(`uses-${connector.id}`, `I use ${connector.name}`, connector.uses, (checked) =>
        update(() => {
          connector.uses = checked;
          if (!checked) connector.connected = false;
        }),
      ),
    );
  }
  if (!connector.uses) return card;

  card.append(
    el('ol', { class: 'steps' }, ...connector.steps[state.assistant].map((step) => el('li', {}, step))),
    healthLine(connector.health) ?? '',
    checkbox(`connected-${connector.id}`, `I've connected ${connector.name}`, connector.connected, (checked) =>
      update(() => (connector.connected = checked)),
    ),
  );

  if (connector.connected) {
    card.append(
      el('h3', {}, `Try asking ${ASSISTANT_LABELS[state.assistant]}`),
      ...connector.prompts.map((prompt) => {
        const text = el('span', {}, prompt);
        const button = el('button', { type: 'button' }, 'Copy');
        button.addEventListener('click', () => copyPrompt(prompt, button, text));
        return el('p', { class: 'prompt' }, text, button);
      }),
    );
  }
  return card;
}

function render() {
  const inUse = state.connectors.filter((connector) => connector.uses);
  const connected = inUse.filter((connector) => connector.connected).length;

  root.replaceChildren(
    el('h1', {}, state.shop.name ? `Connect ${state.shop.name} to your AI assistant` : 'Connect your store to your AI assistant'),
    el('p', { class: 'progress' }, `${connected} of ${inUse.length} tools connected`),
    saveError ? el('p', { class: 'notice error', role: 'alert' }, 'Your last change was not saved. Check your connection and try again.') : '',
    el(
      'fieldset',
      { class: 'assistant' },
      el('legend', {}, 'Which assistant do you use?'),
      ...Object.entries(ASSISTANT_LABELS).map(([value, label]) =>
        el(
          'label',
          { class: 'check', for: `assistant-${value}` },
          el('input', {
            type: 'radio',
            name: 'assistant',
            id: `assistant-${value}`,
            checked: state.assistant === value,
            onchange: () => update(() => (state.assistant = value)),
          }),
          label,
        ),
      ),
    ),
    ...state.connectors.map(connectorCard),
    el('p', { class: 'footer' }, el('a', { href: '/privacy', target: '_blank' }, 'Privacy policy')),
  );
}

try {
  state = await api('/api/state');
  render();
} catch {
  root.replaceChildren(el('p', { class: 'notice error', role: 'alert' }, 'Could not load your setup. Reload the page to try again.'));
}
