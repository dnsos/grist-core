import * as net from 'net';

import {UserProfile} from 'app/common/LoginSessionAPI';
import {Deps as ActiveDocDeps} from 'app/server/lib/ActiveDoc';
import {Deps as DiscourseConnectDeps} from 'app/server/lib/DiscourseConnect';
import {Deps as CommClientDeps} from 'app/server/lib/Client';
import {Comm} from 'app/server/lib/Comm';
import log from 'app/server/lib/log';
import {IMessage, Rpc} from 'grain-rpc';
import {Request} from 'express';
import * as t from 'ts-interface-checker';
import {FlexServer} from './FlexServer';
import {ITestingHooks} from './ITestingHooks';
import ITestingHooksTI from './ITestingHooks-ti';
import {connect, fromCallback} from './serverUtils';
import {WidgetRepositoryImpl} from 'app/server/lib/WidgetRepository';

const tiCheckers = t.createCheckers(ITestingHooksTI, {UserProfile: t.name("object")});

export function startTestingHooks(socketPath: string, port: number,
                                  comm: Comm, flexServer: FlexServer,
                                  workerServers: FlexServer[]): Promise<net.Server> {
  // Create socket server listening on the given path for testing connections.
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.on('listening', () => resolve(server));
    server.on('connection', socket => {
      // On connection, create an Rpc object communicating over that socket.
      const rpc = connectToSocket(new Rpc({logger: {}}), socket);
      // Register the testing implementation.
      rpc.registerImpl('testing',
                       new TestingHooks(port, comm, flexServer, workerServers),
                       tiCheckers.ITestingHooks);
    });
    server.listen(socketPath);
  });
}

function connectToSocket(rpc: Rpc, socket: net.Socket): Rpc {
  socket.setEncoding('utf8');
  socket.on('data', (buf: string) => rpc.receiveMessage(JSON.parse(buf)));
  rpc.setSendMessage((m: IMessage) => fromCallback(cb => socket.write(JSON.stringify(m), 'utf8', cb)));
  return rpc;
}

export interface TestingHooksClient extends ITestingHooks {
  close(): void;
}

export async function connectTestingHooks(socketPath: string): Promise<TestingHooksClient> {
  const socket = await connect(socketPath);
  const rpc = connectToSocket(new Rpc({logger: {}}), socket);
  return Object.assign(rpc.getStub<TestingHooks>('testing', tiCheckers.ITestingHooks), {
    close: () => socket.end(),
  });
}

export class TestingHooks implements ITestingHooks {
  constructor(
    private _port: number,
    private _comm: Comm,
    private _server: FlexServer,
    private _workerServers: FlexServer[]
  ) {}

  public async getOwnPort(): Promise<number> {
    log.info("TestingHooks.getOwnPort called");
    return this._server.getOwnPort();
  }

  public async getPort(): Promise<number> {
    log.info("TestingHooks.getPort called");
    return this._port;
  }

  public async setLoginSessionProfile(gristSidCookie: string, profile: UserProfile|null, org?: string): Promise<void> {
    log.info("TestingHooks.setLoginSessionProfile called with", gristSidCookie, profile, org);
    const sessionId = this._comm.getSessionIdFromCookie(gristSidCookie);
    const scopedSession = this._comm.getOrCreateSession(sessionId as string, {org});
    const req = {} as Request;
    await scopedSession.updateUserProfile(req, profile);
    this._server.getSessions().clearCacheIfNeeded({email: profile?.email, org});
  }

  public async setServerVersion(version: string|null): Promise<void> {
    log.info("TestingHooks.setServerVersion called with", version);
    this._comm.setServerVersion(version);
    for (const server of this._workerServers) {
      server.getComm().setServerVersion(version);
    }
  }

  public async disconnectClients(): Promise<void> {
    log.info("TestingHooks.disconnectClients called");
    this._comm.destroyAllClients();
    for (const server of this._workerServers) {
      server.getComm().destroyAllClients();
    }
  }

  public async commShutdown(): Promise<void> {
    log.info("TestingHooks.commShutdown called");
    await this._comm.testServerShutdown();
    for (const server of this._workerServers) {
      await server.getComm().testServerShutdown();
    }
  }

  public async commRestart(): Promise<void> {
    log.info("TestingHooks.commRestart called");
    await this._comm.testServerRestart();
    for (const server of this._workerServers) {
      await server.getComm().testServerRestart();
    }
  }

  // Set how long new clients will persist after disconnection.
  // Returns the previous value.
  public async commSetClientPersistence(ttlMs: number): Promise<number> {
    log.info("TestingHooks.setClientPersistence called with", ttlMs);
    const prev = CommClientDeps.clientRemovalTimeoutMs;
    CommClientDeps.clientRemovalTimeoutMs = ttlMs;
    return prev;
  }

  public async closeDocs(): Promise<void> {
    log.info("TestingHooks.closeDocs called");
    if (this._server) {
      await this._server.closeDocs();
    }
    for (const server of this._workerServers) {
      await server.closeDocs();
    }
  }

  public async setDocWorkerActivation(workerId: string, active: 'active'|'inactive'|'crash'):
    Promise<void> {
    log.info("TestingHooks.setDocWorkerActivation called with", workerId, active);
    const matches = this._workerServers.filter(
      server => server.worker.id === workerId ||
        server.worker.publicUrl === workerId ||
        (server.worker.publicUrl.startsWith('http://localhost:') &&
          workerId.startsWith('http://localhost:') &&
          new URL(server.worker.publicUrl).host === new URL(workerId).host));
    if (matches.length !== 1) {
      throw new Error(`could not find worker: ${workerId}`);
    }
    const server = matches[0];
    switch (active) {
      case 'active':
        await server.restartListening();
        break;
      case 'inactive':
        await server.stopListening();
        break;
      case 'crash':
        await server.stopListening('crash');
        break;
    }
  }

  public async flushAuthorizerCache(): Promise<void> {
    log.info("TestingHooks.flushAuthorizerCache called");
    this._server.getHomeDBManager().flushDocAuthCache();
    for (const server of this._workerServers) {
      server.getHomeDBManager().flushDocAuthCache();
    }
  }

  public async flushDocs(): Promise<void> {
    log.info("TestingHooks.flushDocs called");
    for (const server of this._workerServers) {
      await server.testFlushDocs();
    }
  }

  // Returns a Map from docId to number of connected clients for all open docs across servers,
  // but represented as an array of pairs, to be serializable.
  public async getDocClientCounts(): Promise<Array<[string, number]>> {
    log.info("TestingHooks.getDocClientCounts called");
    const counts = new Map<string, number>();
    for (const server of [this._server, ...this._workerServers]) {
      const c = await server.getDocClientCounts();
      for (const [key, val] of c) {
        counts.set(key, (counts.get(key) || 0) + val);
      }
    }
    return Array.from(counts);
  }

  // Sets the seconds for ActiveDoc timeout, and returns the previous value.
  public async setActiveDocTimeout(seconds: number): Promise<number> {
    const prev = ActiveDocDeps.ACTIVEDOC_TIMEOUT;
    ActiveDocDeps.ACTIVEDOC_TIMEOUT = seconds;
    return prev;
  }

  // Sets env vars for the DiscourseConnect module, and returns the previous value.
  public async setDiscourseConnectVar(varName: string, value: string|null): Promise<string|null> {
    const key = varName as keyof typeof DiscourseConnectDeps;
    const prev = DiscourseConnectDeps[key] || null;
    if (value == null) {
      delete DiscourseConnectDeps[key];
    } else {
      DiscourseConnectDeps[key] = value;
    }
    return prev;
  }

  public async setWidgetRepositoryUrl(url: string): Promise<void> {
    const repo = this._server.getWidgetRepository() as WidgetRepositoryImpl;
    if (!(repo instanceof WidgetRepositoryImpl)) {
      throw new Error("Unsupported widget repository");
    }
    repo.testOverrideUrl(url);
  }
}
