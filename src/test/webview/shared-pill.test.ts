import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

/** pill.ts imports only Lit — no messaging.js — so no acquireVsCodeApi
 *  stub is needed; setup.js's DOM globals just have to precede the
 *  @customElement registration. */
await import('../../../webview-ui/shared/pill.js');

/**
 * The shared stat pill. Pure display: two text spans plus a reflected
 * `color` attribute. The reflection direction (property → attribute) is
 * the contract worth pinning — the palette is applied by :host([color=…])
 * selectors, which match the DOM attribute, not the JS property.
 */

interface Pill extends HTMLElement {
  updateComplete: Promise<unknown>;
  label: string;
  value: string;
  color: string;
}

async function mount(t: { after(fn: () => void): void }): Promise<Pill> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-pill label="Peers" value="4"></ditto-pill>`, host);
  const el = host.querySelector('ditto-pill') as unknown as Pill;
  await el.updateComplete;
  return el;
}

const labelText = (el: Pill): string =>
  el.shadowRoot!.querySelector('.label')!.textContent ?? '';
const valueText = (el: Pill): string =>
  el.shadowRoot!.querySelector('.value')!.textContent ?? '';

test('Pill: renders the label and value', async t => {
  const el = await mount(t);
  assert.equal(labelText(el), 'Peers');
  assert.equal(valueText(el), '4');
});

test('Pill: color defaults to blue and reflects onto the host attribute', async t => {
  const el = await mount(t);
  assert.equal(el.color, 'blue');
  assert.equal(el.getAttribute('color'), 'blue',
    'the :host([color=…]) selectors match the attribute, so the default must reflect');
});

test('Pill: setting the color property reflects every supported slot', async t => {
  const el = await mount(t);
  for (const color of ['blue', 'green', 'red', 'orange', 'purple'] as const) {
    el.color = color;
    await el.updateComplete;
    assert.equal(el.getAttribute('color'), color,
      `property color=${color} must reach the attribute the CSS keys off`);
  }
});

test('Pill: setting the color attribute updates the property', async t => {
  const el = await mount(t);
  el.setAttribute('color', 'purple');
  assert.equal(el.color, 'purple', 'attribute templates are how callers set color');
  await el.updateComplete;
  assert.equal(el.getAttribute('color'), 'purple', 'no reflect-echo clobbers the attribute');
});

test('Pill: property changes re-render the spans', async t => {
  const el = await mount(t);
  el.label = 'Storage';
  el.value = '21 MB';
  await el.updateComplete;
  assert.equal(labelText(el), 'Storage');
  assert.equal(valueText(el), '21 MB');
});
