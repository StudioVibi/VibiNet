export type RandFn = () => number;

export function create_rng(seed: number): RandFn {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function rand_between(rng: RandFn, min: number, max: number): number {
  return min + (max - min) * rng();
}

export function rand_int(rng: RandFn, min: number, max: number): number {
  return Math.floor(rand_between(rng, min, max + 1));
}

type Event = {
  time: number;
  order: number;
  fn: () => void;
};

export class SimScheduler {
  now = 0;
  private order = 0;
  private events: Event[] = [];

  schedule(delay_ms: number, fn: () => void): void {
    const delay = Math.max(0, Math.floor(delay_ms));
    this.schedule_at(this.now + delay, fn);
  }

  schedule_at(time_ms: number, fn: () => void): void {
    const event = { time: Math.floor(time_ms), order: this.order++, fn };
    this.events.push(event);
    this.events.sort((a, b) => (a.time - b.time) || (a.order - b.order));
  }

  run_until(target_ms: number): void {
    const target = Math.max(this.now, Math.floor(target_ms));
    while (this.events.length > 0) {
      const next = this.events[0];
      if (next.time > target) {
        break;
      }
      this.events.shift();
      this.now = next.time;
      next.fn();
    }
    this.now = target;
  }
}

export type SimPost<P> = {
  room: string;
  index: number;
  server_time: number;
  client_time: number;
  name?: string;
  data: P;
};

export type ClientProfile = {
  uplink_ms: number;
  downlink_ms: number;
  jitter_ms: number;
  clock_offset_ms: number;
  sync_delay_ms?: number;
  duplicate_rate?: number;
  duplicate_delay_ms?: { min: number; max: number };
};

type WatchHandler<P> = (post: SimPost<P>) => void;

type StreamState = {
  watching: boolean;
  next_to_send: number;
};

export class SimServer<P> {
  scheduler: SimScheduler;
  posts_by_room: Map<string, SimPost<P>[]>;
  watchers: Map<string, Set<SimClient<P>>>;
  streams: Map<SimClient<P>, Map<string, StreamState>>;

  constructor(scheduler: SimScheduler) {
    this.scheduler = scheduler;
    this.posts_by_room = new Map();
    this.watchers = new Map();
    this.streams = new Map();
  }

  watch(room: string, client: SimClient<P>): void {
    let set = this.watchers.get(room);
    if (!set) {
      set = new Set();
      this.watchers.set(room, set);
    }
    set.add(client);
    const stream = this.get_stream_state(room, client);
    stream.watching = true;
    this.drain(room, client, stream);
  }

  load(room: string, from: number, client: SimClient<P>): void {
    const stream = this.get_stream_state(room, client);
    stream.next_to_send = Math.max(stream.next_to_send, Math.max(0, from));
    const one_shot_limit = stream.watching
      ? undefined
      : this.get_posts(room).length;
    this.drain(room, client, stream, one_shot_limit);
  }

  receive_post(
    room: string,
    name: string,
    data: P,
    client_time: number
  ): void {
    const posts = this.posts_by_room.get(room) ?? [];
    const post: SimPost<P> = {
      room,
      index: posts.length,
      server_time: this.scheduler.now,
      client_time,
      name,
      data,
    };
    posts.push(post);
    this.posts_by_room.set(room, posts);

    const watchers = this.watchers.get(room);
    if (!watchers) {
      return;
    }
    for (const client of watchers) {
      const stream = this.get_stream_state(room, client);
      this.drain(room, client, stream);
    }
  }

  get_posts(room: string): SimPost<P>[] {
    return this.posts_by_room.get(room) ?? [];
  }

  private get_stream_state(room: string, client: SimClient<P>): StreamState {
    let rooms = this.streams.get(client);
    if (!rooms) {
      rooms = new Map();
      this.streams.set(client, rooms);
    }
    let stream = rooms.get(room);
    if (!stream) {
      stream = { watching: false, next_to_send: 0 };
      rooms.set(room, stream);
    }
    return stream;
  }

  private drain(
    room: string,
    client: SimClient<P>,
    stream: StreamState,
    max_index_exclusive?: number
  ): void {
    const posts = this.get_posts(room);
    const limit = max_index_exclusive === undefined
      ? posts.length
      : Math.min(posts.length, max_index_exclusive);
    while (stream.next_to_send < limit) {
      client.schedule_delivery(posts[stream.next_to_send]);
      stream.next_to_send += 1;
    }
  }
}

export class SimNetwork<P> {
  rng: RandFn;
  scheduler: SimScheduler;
  server: SimServer<P>;

  constructor(rng: RandFn) {
    this.rng = rng;
    this.scheduler = new SimScheduler();
    this.server = new SimServer<P>(this.scheduler);
  }

  create_client(id: string, profile: ClientProfile): SimClient<P> {
    return new SimClient<P>(id, profile, this);
  }
}

export class SimClient<P> {
  id: string;
  profile: ClientProfile;
  network: SimNetwork<P>;
  handlers: Map<string, WatchHandler<P>>;
  latest_post_index_listeners: Array<
    (info: { room: string; latest_index: number; server_time: number }) => void
  >;
  last_ping: number;
  private seq = 0;
  private uplink_ready_at = 0;
  private downlink_ready_at = 0;

  constructor(id: string, profile: ClientProfile, network: SimNetwork<P>) {
    this.id = id;
    this.profile = profile;
    this.network = network;
    this.handlers = new Map();
    this.latest_post_index_listeners = [];
    this.last_ping = Infinity;
  }

  on_sync(callback: () => void): void {
    const delay = this.profile.sync_delay_ms ?? 0;
    this.network.scheduler.schedule(delay, callback);
  }

  server_time(): number {
    const now = this.network.scheduler.now + this.profile.clock_offset_ms;
    return Math.floor(now);
  }

  ping(): number {
    return this.last_ping;
  }

  post(room: string, data: P, _packed: any): string {
    const name = `${this.id}-${this.seq++}`;
    const client_time = this.server_time();
    const uplink = this.sample_one_way(this.profile.uplink_ms);
    this.last_ping = this.sample_rtt();
    const send_at = this.network.scheduler.now + uplink;
    const arrival_at = Math.max(send_at, this.uplink_ready_at);
    this.uplink_ready_at = arrival_at;
    this.network.scheduler.schedule_at(arrival_at, () => {
      this.network.server.receive_post(room, name, data, client_time);
    });
    return name;
  }

  watch(room: string, _packed: any, handler?: WatchHandler<P>): void {
    if (handler) {
      this.handlers.set(room, handler);
    }
    this.network.server.watch(room, this);
  }

  load(room: string, from: number, _packed: any): void {
    this.network.server.load(room, from, this);
  }

  get_latest_post_index(room: string): void {
    const one_way = this.sample_one_way(this.profile.downlink_ms);
    const deliver_at = Math.max(
      this.network.scheduler.now + one_way,
      this.downlink_ready_at
    );
    this.downlink_ready_at = deliver_at;
    this.network.scheduler.schedule_at(deliver_at, () => {
      const latest_index = this.network.server.get_posts(room).length - 1;
      const info = {
        room,
        latest_index,
        server_time: this.network.scheduler.now,
      };
      for (const listener of this.latest_post_index_listeners) {
        listener(info);
      }
    });
  }

  on_latest_post_index(
    callback: (info: { room: string; latest_index: number; server_time: number }) => void
  ): void {
    this.latest_post_index_listeners.push(callback);
  }

  schedule_delivery(post: SimPost<P>): void {
    const delay = this.sample_one_way(this.profile.downlink_ms);
    const send_at = this.network.scheduler.now + delay;
    const deliver_at = Math.max(send_at, this.downlink_ready_at);
    this.downlink_ready_at = deliver_at;
    this.network.scheduler.schedule_at(deliver_at, () => {
      const handler = this.handlers.get(post.room);
      if (handler) {
        handler(post);
      }
    });

    const dup_rate = this.profile.duplicate_rate ?? 0;
    if (dup_rate <= 0) {
      return;
    }
    if (this.network.rng() > dup_rate) {
      return;
    }
    const range = this.profile.duplicate_delay_ms ?? { min: 10, max: 200 };
    const extra = rand_between(this.network.rng, range.min, range.max);
    const dup_at = deliver_at + Math.max(0, Math.floor(extra));
    this.network.scheduler.schedule_at(dup_at, () => {
      const handler = this.handlers.get(post.room);
      if (handler) {
        handler(post);
      }
    });
  }

  private sample_jitter(): number {
    const jitter = this.profile.jitter_ms;
    if (jitter <= 0) {
      return 0;
    }
    return rand_between(this.network.rng, -jitter, jitter);
  }

  private sample_one_way(base: number): number {
    return Math.max(0, Math.floor(base + this.sample_jitter()));
  }

  private sample_rtt(): number {
    const up = this.sample_one_way(this.profile.uplink_ms);
    const down = this.sample_one_way(this.profile.downlink_ms);
    return Math.max(0, Math.floor(up + down));
  }
}
