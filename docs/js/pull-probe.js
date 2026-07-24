import {
  DEFAULT_POST_BOMB_SEED,
  DEFAULT_SWORD_OFFSETS,
  PullTracker,
  parseSeed,
  rollDistance,
} from './pull-probe-core.js';

const $ = (id) => document.getElementById(id);
const seedInput = $('base-seed');
const portInput = $('port');
const status = $('status');
const live = $('live');
const rows = $('rows');
const tracker = new PullTracker(DEFAULT_POST_BOMB_SEED);

seedInput.value = `0x${DEFAULT_POST_BOMB_SEED.toString(16).toUpperCase().padStart(8, '0')}`;
$('offsets').textContent = DEFAULT_SWORD_OFFSETS.join(', ');

function hex(seed) {
  return seed === null || seed === undefined
    ? '—'
    : `0x${(seed >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function nearest(distance) {
  if (distance < 0) return { offset: null, delta: null };
  const offset = DEFAULT_SWORD_OFFSETS.reduce((best, value) =>
    Math.abs(value - distance) < Math.abs(best - distance) ? value : best);
  return { offset, delta: distance - offset };
}

function applySeed() {
  const parsed = parseSeed(seedInput.value);
  seedInput.classList.toggle('invalid', parsed === null);
  if (parsed === null) return;
  tracker.setBaseSeed(parsed);
}
seedInput.addEventListener('change', applySeed);
seedInput.addEventListener('input', applySeed);

function addPull(event) {
  const close = event.pull === 3 && event.targets === 6;
  const n = nearest(event.distance);
  const row = document.createElement('tr');
  if (close) row.className = 'target-pull';
  const values = [
    event.attempt,
    event.pull,
    event.targets ?? '—',
    event.transitionFrame,
    hex(event.priorSeed),
    event.priorDistance < 0 ? 'off orbit' : event.priorDistance,
    hex(event.boundarySeed),
    event.distance < 0 ? 'off orbit' : event.distance,
    event.entryRolls < 0 ? '—' : event.entryRolls,
    n.offset === null ? '—' : `${n.offset} (${n.delta >= 0 ? '+' : ''}${n.delta})`,
  ];
  for (const value of values) {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.appendChild(cell);
  }
  rows.prepend(row);
  if (close) {
    $('result').textContent = `Third pull at 6 targets: prior ${event.priorDistance} rolls ` +
      `(${hex(event.priorSeed)}), entry ${event.distance} rolls ` +
      `(${hex(event.boundarySeed)}), ${event.entryRolls} calls during entry.`;
  }
}

let client;
function connect() {
  const port = Number(portInput.value);
  tracker.resetRun();
  if (client) client.close();
  const actionState = `player.${port}.entity.action_state`;
  const actionFrame = `player.${port}.entity.action_frame`;
  client = new window.MProtocol({
    subscribe: [
      'frame',
      'match.random_seed',
      'stage.btargets.remaining',
      actionState,
      actionFrame,
    ],
  });

  client.on('connecting', () => { status.textContent = 'connecting to m-protocol…'; });
  client.on('welcome', () => { status.textContent = 'daemon connected; waiting for Dolphin…'; });
  client.on('attach', (message) => {
    status.textContent = `attached to ${message.process || 'Dolphin'}`;
  });
  client.on('detach', () => { status.textContent = 'Dolphin detached'; });
  client.on('reconnect', () => { status.textContent = 'daemon unavailable; retrying…'; });
  client.on('lagged', () => { status.textContent = 'attached, but samples were dropped'; });

  const sample = () => {
    const frame = client.get('frame');
    const seed = client.get('match.random_seed');
    const targets = client.get('stage.btargets.remaining');
    const state = client.get(actionState);
    const action = client.get(actionFrame);
    if (!Number.isInteger(frame) || !Number.isInteger(seed)) return;
    const distance = rollDistance(tracker.baseSeed, seed);
    live.textContent = `frame ${frame} · seed ${hex(seed)} · ` +
      `distance ${distance < 0 ? 'off orbit' : distance} · ` +
      `targets ${Number.isInteger(targets) ? targets : '—'} · action ${state ?? '—'}`;
    const event = tracker.consume({
      frame,
      seed,
      targets: Number.isInteger(targets) ? targets : null,
      actionState: state,
      actionFrame: action,
    });
    if (event) addPull(event);
  };
  client.on('snapshot', sample);
  client.on('delta', sample);
  client.connect();
}

portInput.addEventListener('change', connect);
$('clear').addEventListener('click', () => {
  rows.replaceChildren();
  $('result').textContent = 'Waiting for the third pull with six targets remaining…';
});
connect();
