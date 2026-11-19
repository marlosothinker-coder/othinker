// probeUrl is the connector's public endpoint, checked weekly. Leave it null
// until the URL is confirmed against the vendor's own documentation.
export const ASSISTANTS = ['claude', 'chatgpt'];

const connectSteps = (name) => ({
  claude: [
    'In Claude, open Settings and go to Connectors.',
    `Find ${name} in the connector directory and choose Connect.`,
    `Sign in to ${name} and approve the access it asks for.`,
  ],
  chatgpt: [
    'In ChatGPT, open Settings and go to Apps & Connectors.',
    `Find ${name} and choose Connect.`,
    `Sign in to ${name} and approve the access it asks for.`,
  ],
});

export const CONNECTORS = [
  {
    id: 'shopify',
    name: 'Shopify',
    category: 'Store',
    required: true,
    why: 'Orders, inventory, products and customers. Every other tool is checked against this.',
    steps: connectSteps('Shopify'),
    prompts: [
      'Which of my {productCount} products will run out of stock first at the current sales rate?',
      'What were my top 5 products last week after refunds?',
    ],
    probeUrl: null,
  },
  {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    category: 'Books',
    why: 'Invoices, expenses and profit and loss, so month-end does not mean comparing two apps by hand.',
    steps: connectSteps('QuickBooks'),
    prompts: ["Compare this month's Shopify revenue for {shopName} with what has landed in QuickBooks."],
    probeUrl: null,
  },
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'Inbox',
    why: 'Where the "where is my order" emails and complaints live.',
    steps: connectSteps('Gmail'),
    prompts: ['Draft replies to the five oldest unanswered order-status emails.'],
    probeUrl: null,
  },
  {
    id: 'google-sheets',
    name: 'Google Sheets',
    category: 'Reporting',
    why: 'For the one-off report your accountant asks for that the Shopify dashboard does not build.',
    steps: connectSteps('Google Sheets'),
    prompts: ["Export last quarter's top 20 products by margin into a new sheet."],
    probeUrl: null,
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'Alerts',
    why: 'So low-stock warnings and large orders reach the team channel, not only your inbox.',
    steps: connectSteps('Slack'),
    prompts: ['Post a summary of overnight orders to our ops channel.'],
    probeUrl: 'https://mcp.slack.com/mcp',
  },
];

export const CONNECTOR_IDS = CONNECTORS.map((connector) => connector.id);

export function fillPrompt(template, profile) {
  const productCount = profile?.productCount;
  return template
    .replace('{shopName}', profile?.name ?? 'my store')
    .replace('my {productCount} products', productCount ? `my ${productCount} products` : 'my products');
}
