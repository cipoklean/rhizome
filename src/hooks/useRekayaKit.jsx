/**
 * RekayaKit connector — a starknet-kit-style connector that delegates to a
 * Rekaya wallet bridge via HTTP (or a localhost MCP-bridge endpoint).
 *
 * Public surface modelled on @starknet-react/core connectors so existing
 * starknet-kit mental model carries over, but this is self-contained — no
 * external connector dependency.
 *
 * Architecture note — Rekaya transport
 * --------------------------------------
 * The JS bundle calls a Rekaya HTTP endpoint (configured via `rekayaEndpoint`).
 * That endpoint is either:
 *   (a) a Rekaya-hosted wallet-bridge API, OR
 *   (b) a localhost bridge (e.g. a native-messaging host or an MCP bridge
 *       daemon) that the dapp reaches over HTTP on localhost.
 *
 * The `rekaya_request` MCP tool exposed to the agent is a *host-side* testing
 * surface — it is NOT what the browser bundle calls. The bundle uses fetch().
 * The host-side tool exists so an agent can drive the same wallet flow for
 * QA / scripted runs without a human approving every popup.
 *
 * Expected Rekaya API shape (normalised by this connector):
 *   wallet_list          → { wallets: [{ id, name, icon_url?, installed: bool }] }
 *   wallet_connect       → { wallet_id, chain_id? } → { accounts: [{ address, chain_id }], provider_url? }
 *   wallet_disconnect   → { wallet_id? }           → { success: bool }
 *   wallet_balance       → { address, token? }     → { balance: string, token_address? }
 *   wallet_transactions  → { address, from_address?, to_address?, limit?, offset?, timeframe_ms? }
 *                          → { transactions: [...], total: number }
 *   wallet_approve_tx    → { wallet_id, tx_request } → { hash, status }
 *
 * All timestamps are epoch millis. All numeric values are strings unless noted.
 */

const DEFAULT_REKAYA_ENDPOINT = "http://localhost:8973/v1";
const DEFAULT_TIMEOUT_MS = 12000;

// ---- tiny fmt helpers ----

const fmtAddress = (a) =>
  typeof a === "string" && a.length === 66 ? `0x${a.slice(2)}` : a;

const fmtChainId = (c) =>
  typeof c === "string" && !c.startsWith("0x") && c.length < 70
    ? `0x${parseInt(c, 10).toString(16)}`
    : c;

// ---- connector (no React dependency — loadable in plain Node / vitest) ----

export class RekayaKitConnector {
  /** @type {string | null} */
  #endpoint = null;

  /** @type {string | null} */
  #projectId = null;

  /** @type {string | null} */
  #chainId = null;

  /** @type {{ accounts?: { address: string; chain_id: string }[]; provider?: unknown; signer?: unknown; chainId?: string } | null} */
  #session = null;

  /** @type {string | null} */
  #walletId = null;

  /**
   * @param {object} [opts]
   * @param {string} [opts.projectId]         arbitrary dapp identifier forwarded to Rekaya (for analytics / resubscription prompts)
   * @param {string} [opts.rekayaEndpoint]    HTTP base for the Rekaya bridge; default localhost bridge
   * @param {string} [opts.chain]             default chain alias (e.g. "SN_MAIN", "SN_SEPOLIA"); resolved to felt if needed by the bridge
   */
  constructor({ projectId, rekayaEndpoint, chain } = {}) {
    if (projectId != null) this.#projectId = String(projectId);
    if (rekayaEndpoint != null) this.#endpoint = String(rekayaEndpoint);
    if (chain != null) this.#chainId = fmtChainId(chain);
  }

  get projectId() {
    return this.#projectId;
  }

  get endpoint() {
    return this.#endpoint;
  }

  get chainId() {
    return this.#chainId;
  }

  /** True after a successful connect, regardless of current connection health. */
  get isConnected() {
    return (
      this.#session != null &&
      Array.isArray(this.#session.accounts) &&
      this.#session.accounts.length > 0
    );
  }

  /** Most recently connected account address, or null. */
  get address() {
    return this.#session?.accounts?.[0]?.address ?? null;
  }

  /** Chain id returned by the wallet at connect time, or the configured default. */
  get connectedChainId() {
    return (
      (this.#session?.accounts?.[0]?.chain_id ?? this.#chainId) ??
      null
    );
  }

  /** Most recently connected accounts, or null before the first successful connect. */
  get accounts() {
    return this.#session?.accounts ?? null;
  }

  /** Wallet id used for the current session, or null. */
  get walletId() {
    return this.#walletId;
  }

  /**
   * Resolve the connector's configuration. Called inside hooks / React render,
   * and before any bridge call, so misconfiguration fails loud and early.
   */
  ensureConfig() {
    if (this.#endpoint == null) {
      throw new Error(
        "RekayaKitConnector: rekayaEndpoint is required. Pass it to the constructor or set endpoint."
      );
    }
    if (!this.#endpoint.startsWith("http")) {
      throw new Error(
        `RekayaKitConnector: rekayaEndpoint must be an http(s) URL, got "${this.#endpoint}"`
      );
    }
    return {
      endpoint: this.#endpoint,
      projectId: this.#projectId ?? "rhizome",
      chainId: this.#chainId,
    };
  }

  /**
   * Low-level bridge call. Every public method goes through here so timeouts,
   * error wrapping, and response normalisation live in one place.
   *
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<object>}
   */
  async #call(method, params = {}) {
    const { endpoint, projectId, chainId } = this.ensureConfig();
    const body = {
      jsonrpc: "2.0",
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      method,
      params: { ...params, _dapp: projectId, _chain: chainId },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${endpoint}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = res.statusText;
        try {
          const j = await res.json();
          detail = j.error?.message ?? j.message ?? detail;
        } catch {}
        throw new Error(`Rekaya bridge responded ${res.status}: ${detail}`);
      }

      const json = (await res.json()) ?? {};
      if (json.error != null) {
        throw new Error(
          `Rekaya bridge error [${method}]: ${json.error.message ?? JSON.stringify(json.error)}`
        );
      }
      if (json.result == null) {
        throw new Error(`Rekaya bridge [${method}] returned no result`);
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  // ----- wallet discovery -----

  /**
   * List wallets known to the Rekaya bridge. Mirrors starknet-kit's
   * `isWalletInstalled` / `getAvailableWallets` shape.
   *
   * @returns {Promise<Array<{ id: string; name: string; icon_url?: string; installed: boolean }>>}
   */
  async getAvailableWallets() {
    const wallets = await this.#call("wallet_list");
    if (!Array.isArray(wallets)) {
      throw new Error("Rekaya bridge wallet_list did not return an array");
    }
    return wallets.map((w) => ({
      id: String(w.id ?? ""),
      name: String(w.name ?? "Unknown wallet"),
      icon_url: w.icon_url != null ? String(w.icon_url) : undefined,
      installed: Boolean(w.installed),
    }));
  }

  /**
   * Is the named wallet installed / reachable through the bridge?
   * Convenience wrapper around getAvailableWallets for consumers that only
   * care about one wallet.
   *
   * @param {string} walletId
   * @returns {Promise<boolean>}
   */
  async isWalletInstalled(walletId) {
    if (walletId == null) return false;
    const list = await this.getAvailableWallets();
    return list.some((w) => w.id === walletId && w.installed);
  }

  // ----- connection -----

  /**
   * Connect to a specific Rekaya wallet.
   *
   * @param {object} [opts]
   * @param {string} [opts.walletId]   which wallet to connect (required if more than one installed wallet exists)
   * @param {string} [opts.chainId]    requested chain; defaults to the connector's configured chain
   * @returns {Promise<{ accounts: { address: string; chain_id: string }[]; provider: unknown; signer: unknown; chainId: string }>}
   */
  async connect({ walletId, chainId } = {}) {
    const { chainId: configuredChain } = this.ensureConfig();
    const requestedChain = chainId != null ? fmtChainId(chainId) : configuredChain;

    if (walletId == null) {
      // auto-pick first installed wallet when the caller didn't specify
      const list = await this.getAvailableWallets();
      const installed = list.filter((w) => w.installed);
      if (installed.length === 0) {
        throw new Error("RekayaKitConnector: no installed wallet found");
      }
      if (installed.length > 1) {
        throw new Error(
          "RekayaKitConnector: more than one installed wallet and no walletId specified. Pass walletId."
        );
      }
      walletId = installed[0].id;
    }

    const result = await this.#call("wallet_connect", {
      wallet_id: walletId,
      chain_id: requestedChain,
    });

    const accounts = Array.isArray(result.accounts)
      ? result.accounts.map((a) => ({
          address: fmtAddress(String(a.address)),
          chain_id: fmtChainId(String(a.chain_id ?? requestedChain)),
        }))
      : [];

    if (accounts.length === 0) {
      throw new Error("Rekaya bridge wallet_connect returned no accounts");
    }

    const provider = result.provider ?? this.#buildProviderFallback(accounts[0]);
    const signer = result.signer ?? this.#buildSignerFallback(accounts[0], provider);

    this.#session = {
      accounts,
      provider,
      signer,
      chainId: accounts[0].chain_id,
    };
    this.#walletId = walletId;

    return {
      accounts,
      provider,
      signer,
      chainId: accounts[0].chain_id,
    };
  }

  /**
   * Disconnect the current session (and optionally the named wallet).
   *
   * @param {object} [opts]
   * @param {string} [opts.walletId]  if omitted, disconnects the current session only
   * @returns {Promise<{ success: boolean }>}
   */
  async disconnect({ walletId } = {}) {
    const target = walletId ?? this.#walletId;
    if (target == null) {
      this.#session = null;
      this.#walletId = null;
      return { success: true };
    }

    try {
      await this.#call("wallet_disconnect", { wallet_id: target });
    } catch (e) {
      // best-effort: clear local session regardless of bridge response
      console.warn(
        "[RekayaKitConnector] disconnect bridge call failed, clearing local session:",
        e
      );
    } finally {
      if (target === this.#walletId) {
        this.#session = null;
        this.#walletId = null;
      }
    }

    return { success: true };
  }

  // ----- provider / signer accessors -----

  /**
   * Provider from the active session. Throws if not connected.
   * The returned value is whatever the Rekaya bridge gave us — often a
   * starknet.js provider-like object. Consumers should treat it as an
   * opaque provider and go through the hooks / starknet.js adapter.
   */
  getProvider() {
    if (!this.isConnected) {
      throw new Error("RekayaKitConnector: not connected");
    }
    return this.#session.provider;
  }

  /**
   * Signer from the active session. Throws if not connected.
   */
  getSigner() {
    if (!this.isConnected) {
      throw new Error("RekayaKitConnector: not connected");
    }
    return this.#session.signer;
  }

  // ----- account-centric reads -----

  /**
   * Return the active account address. Throws if not connected.
   */
  getActiveAddress() {
    if (!this.isConnected) {
      throw new Error("RekayaKitConnector: not connected");
    }
    return this.#session.accounts[0].address;
  }

  // ----- fallback construction when the bridge omits provider/signer -----

  /**
   * Build a minimal provider-shaped object from the account address when the
   * bridge didn't return one. This is a last resort — consumers should
   * prefer the bridge-provided provider. The shape is deliberately narrow so
   * callers don't assume a full starknet.js provider.
   */
  #buildProviderFallback({ address, chain_id }) {
    const self = this;
    return {
      address: () => Promise.resolve(address),
      chainId: () => Promise.resolve(chain_id),
      // stale placeholder — real use should go through the bridge's provider
      getBlockNumber: async () => {
        throw new Error(
          "RekayaKitConnector: provider.getBlockNumber not available from this bridge session; use the bridge-provided provider or another RPC."
        );
      },
    };
  }

  /**
   * Build a minimal signer-shaped object when the bridge didn't return one.
   * Also a last resort.
   */
  #buildSignerFallback({ address }, provider) {
    const self = this;
    return {
      address: address,
      provider,
      // Placeholder — real signing must go through the wallet / bridge.
      sign: async () => {
        throw new Error(
          "RekayaKitConnector: signer.sign not available from this bridge session; use the bridge-provided signer."
        );
      },
    };
  }
}

// ---- React — top-level dynamic import guard (no static React import) ----

/**
 * React is loaded lazily via a top-level dynamic import so that:
 *  - the non-React exports (RekayaKitConnector, discoverWallets) are
 *    available even when this file is imported in a plain Node / vitest
 *    context with no React installed, AND
 *  - in a React app (Vite + React present), hooks and WalletSelector just
 *    work because the dynamic import resolves to the real react module.
 *
 * In a React app this await resolves nearly instantly (local package); in a
 * non-React context it rejects and React stays null, so hooks throw at call
 * time with a clear message instead of crashing the module load.
 */
const ReactModule = await import("react").catch(() => null);
const React = ReactModule ?? null;

const ReactAPIs = React
  ? {
      useState: React.useState,
      useMemo: React.useMemo,
      useEffect: React.useEffect,
      useCallback: React.useCallback,
    }
  : {};

function ensureReact() {
  if (!React) {
    throw new Error(
      "useRekayaKit hooks require React — install react and react-dom, or import only the non-React exports (RekayaKitConnector, discoverWallets) in a plain Node context."
    );
  }
  return React;
}

// ---- hooks (require React at call time) ----

/**
 * Hook state for a RekayaKitConnector. Exposes connection lifecycle, the
 * available wallet list, and connect/disconnect actions. The connector is
 * created once per hook instance (useMemo) so repeated renders don't re-init.
 *
 * @returns {{
 *   connector: RekayaKitConnector;
 *   connecting: boolean;
 *   accounts: { address: string; chain_id: string }[] | null;
 *   chainId: string | null;
 *   address: string | null;
 *   availableWallets: { id: string; name: string; installed: boolean; icon_url?: string }[];
 *   error: Error | null;
 *   connect: (opts?: { walletId?: string; chainId?: string }) => Promise<unknown>;
 *   disconnect: (opts?: { walletId?: string }) => Promise<unknown>;
 *   refreshWallets: () => Promise<void>;
 * }}
 */
export function useRekayaConnector({
  projectId,
  rekayaEndpoint,
  chain,
  autoRefreshWallets = true,
} = {}) {
  ensureReact();
  const { useState, useMemo, useEffect, useCallback } = ReactAPIs;

  const connector = useMemo(
    () => new RekayaKitConnector({ projectId, rekayaEndpoint, chain }),
    [projectId, rekayaEndpoint, chain]
  );

  const [connecting, setConnecting] = useState(false);
  const [accounts, setAccounts] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [address, setAddress] = useState(null);
  const [availableWallets, setAvailableWallets] = useState([]);
  const [error, setError] = useState(null);

  const refreshWallets = useCallback(async () => {
    try {
      const wallets = await connector.getAvailableWallets();
      setAvailableWallets(wallets);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [connector]);

  // initial wallet list — fire once per hook lifetime
  useEffect(() => {
    if (autoRefreshWallets) refreshWallets();
  }, [refreshWallets, autoRefreshWallets]);

  const connect = useCallback(
    async ({ walletId, chainId: requestedChain } = {}) => {
      setConnecting(true);
      setError(null);
      try {
        const session = await connector.connect({
          walletId,
          chainId: requestedChain,
        });
        setAccounts(session.accounts);
        setChainId(session.chainId);
        setAddress(session.accounts[0]?.address ?? null);
        // refresh wallet list after connect so installed/uninstalled state is current
        await refreshWallets();
        return session;
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
        throw e;
      } finally {
        setConnecting(false);
      }
    },
    [connector, refreshWallets]
  );

  const disconnect = useCallback(
    async ({ walletId } = {}) => {
      setError(null);
      try {
        const result = await connector.disconnect({ walletId });
        setAccounts(null);
        setChainId(null);
        setAddress(null);
        await refreshWallets();
        return result;
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
        throw e;
      }
    },
    [connector, refreshWallets]
  );

  return {
    connector,
    connecting,
    accounts,
    chainId,
    address,
    availableWallets,
    error,
    connect,
    disconnect,
    refreshWallets,
  };
}

/**
 * Balance hook for the connected account (or any address when the bridge
 * exposes balance lookups).
 *
 * @param {object} [params]
 * @param {string} [params.address]  address to query; defaults to the connector's connected address
 * @param {string} [params.token]    optional token address (e.g. STRK); when omitted queries native/ETH-equivalent if supported
 * @param {RekayaKitConnector} [params.connector]  connector to use (auto-created when omitted — not recommended in production, pass an existing one)
 * @returns {{
 *   balance: string | null;
 *   token: string | null;
 *   loading: boolean;
 *   error: Error | null;
 *   refetch: () => Promise<void>;
 * }}
 */
export function useRekayaBalance({
  address: targetAddress,
  token,
  connector: maybeConnector,
} = {}) {
  ensureReact();
  const { useState, useEffect, useCallback } = ReactAPIs;

  const connector =
    maybeConnector ??
    new RekayaKitConnector({
      projectId: "rhizome",
      rekayaEndpoint: DEFAULT_REKAYA_ENDPOINT,
    });

  const [balance, setBalance] = useState(null);
  const [receivedToken, setReceivedToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchBalance = useCallback(
    async ({ address, token: t } = {}) => {
      const addr = address ?? connector.address;
      if (addr == null) {
        setError(
          new Error(
            "useRekayaBalance: no address available; connect a wallet first or pass address."
          )
        );
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await connector.call("wallet_balance", {
          address: addr,
          token: t ?? undefined,
        });
        setBalance(String(result.balance ?? ""));
        setReceivedToken(
          result.token_address != null ? String(result.token_address) : t ?? null
        );
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setLoading(false);
      }
    },
    // connector from the outer scope — stable for the hook's lifetime
    [connector]
  );

  // auto-fetch when an address is available
  useEffect(() => {
    if (targetAddress != null || connector.address != null) {
      fetchBalance({ address: targetAddress, token });
    }
  }, [fetchBalance, targetAddress, token]);

  const refetch = useCallback(
    () => fetchBalance({ address: targetAddress, token }),
    [fetchBalance, targetAddress, token]
  );

  return {
    balance,
    token: receivedToken,
    loading,
    error,
    refetch,
  };
}

/**
 * Transactions hook. Filters the Rekaya `wallet_transactions` stream by
 * `from_address` / `to_address` (included-time filtering where the bridge
 * supports it; else post-filtered here).
 *
 * @param {object} [params]
 * @param {string} [params.address]        account address to query
 * @param {string} [params.fromAddress]    filter to txs where this address sent
 * @param {string} [params.toAddress]      filter to txs where this address received
 * @param {number} [params.limit]          page size
 * @param {number} [params.offset]         pagination offset
 * @param {number} [params.timeframeMs]    how far back to look, in ms
 * @param {RekayaKitConnector} [params.connector]
 * @returns {{
 *   transactions: {
 *     hash: string;
 *     block_number?: number;
 *     from_address: string;
 *     to_address: string;
 *     value: string;
 *     timestamp?: number;
 *     toLocaleString: () => string;
 *   }[];
 *   total: number;
 *   loading: boolean;
 *   error: Error | null;
 *   refetch: () => Promise<void>;
 * }}
 */
export function useRekayaTransactions({
  address: targetAddress,
  fromAddress,
  toAddress,
  limit,
  offset,
  timeframeMs,
  connector: maybeConnector,
} = {}) {
  ensureReact();
  const { useState, useEffect, useCallback } = ReactAPIs;

  const connector =
    maybeConnector ??
    new RekayaKitConnector({
      projectId: "rhizome",
      rekayaEndpoint: DEFAULT_REKAYA_ENDPOINT,
    });

  const [transactions, setTransactions] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchTransactions = useCallback(
    async ({
      address,
      from,
      to,
      lim,
      off,
      tf,
    } = {}) => {
      const addr = address ?? connector.address;
      if (addr == null) {
        setError(
          new Error(
            "useRekayaTransactions: no address available; connect a wallet first or pass address."
          )
        );
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await connector.call("wallet_transactions", {
          address: addr,
          from_address: from ?? undefined,
          to_address: to ?? undefined,
          limit: lim ?? undefined,
          offset: off ?? undefined,
          timeframe_ms: tf ?? undefined,
        });

        const list =
          Array.isArray(result.transactions) ? result.transactions : [];
        const filtered =
          from || to
            ? list.filter((tx) => {
                const fromMatch =
                  from != null
                    ? String(tx.from_address ?? "").toLowerCase() ===
                      String(from).toLowerCase()
                    : true;
                const toMatch =
                  to != null
                    ? String(tx.to_address ?? "").toLowerCase() ===
                      String(to).toLowerCase()
                    : true;
                return fromMatch && toMatch;
              })
            : list;

        setTransactions(
          filtered.map((tx) => ({
            hash: String(tx.hash ?? ""),
            block_number:
              tx.block_number != null ? Number(tx.block_number) : undefined,
            from_address: String(tx.from_address ?? ""),
            to_address: String(tx.to_address ?? ""),
            value: String(tx.value ?? "0"),
            timestamp:
              tx.timestamp != null ? Number(tx.timestamp) : undefined,
            toLocaleString() {
              return `tx ${this.hash.slice(0, 10)}… · ${this.from_address.slice(0, 10)}… → ${this.to_address.slice(0, 10)}…`;
            },
          }))
        );
        setTotal(Number(result.total ?? filtered.length));
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setLoading(false);
      }
    },
    [
      connector,
      targetAddress,
      fromAddress,
      toAddress,
      limit,
      offset,
      timeframeMs,
    ]
  );

  useEffect(() => {
    if (targetAddress != null || connector.address != null) {
      fetchTransactions({
        address: targetAddress,
        from: fromAddress,
        to: toAddress,
        lim: limit,
        off: offset,
        tf: timeframeMs,
      });
    }
  }, [fetchTransactions, targetAddress, fromAddress, toAddress, limit, offset, timeframeMs]);

  const refetch = useCallback(
    () =>
      fetchTransactions({
        address: targetAddress,
        from: fromAddress,
        to: toAddress,
        lim: limit,
        off: offset,
        tf: timeframeMs,
      }),
    [
      fetchTransactions,
      targetAddress,
      fromAddress,
      toAddress,
      limit,
      offset,
      timeframeMs,
    ]
  );

  return {
    transactions,
    total,
    loading,
    error,
    refetch,
  };
}

// ---- components ----

const ADDRESS_TRUNC = (a) =>
  typeof a === "string" && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

/**
 * Standalone wallet selector driven by a RekayaKitConnector. Handles:
 *  - discovery state (loading wallets, no wallets found)
 *  - per-wallet connect / disconnect
 *  - explicit connection states (disconnected, connecting, connected,
 *    wrong network, rejected, session expired) surfaced as messages
 *  - a one-line explanation before any balance-read prompt (rendered by the
 *    caller when they trigger a balance read, but the connector exposes the
 *    raw call so the caller can show the prompt)
 *
 * @param {object} props
 * @param {RekayaKitConnector} props.connector
 * @param {boolean} [props.showBalanceCaveat]  when true, render a one-line note before the first balance read
 * @param {string} [props.expectedChainId]     when set, surface a "wrong network" hint when connected chain differs
 * @param {string} [props.className]
 * @param {React.ReactNode} [props.children]   optional override of the default selector UI
 */
export function WalletSelector({
  connector,
  showBalanceCaveat = false,
  expectedChainId,
  className,
  children,
}) {
  ensureReact();
  const { useState, useMemo } = ReactAPIs;

  // Re-use the passed connector's state via a local hook that wraps it.
  // We can't call useRekayaConnector here and pass a connector instance
  // because that hook creates its own connector — instead we track the
  // connector's live state with local state synced by the caller.
  //
  // For a self-contained selector, we re-run the connector's discovery and
  // track its isConnected/address/chainId locally. This keeps the component
  // self-contained while still delegating wallet ops to the connector.
  const [{ localWallets, localConnecting, localError }, setState] = useState({
    localWallets: [],
    localConnecting: false,
    localError: null,
  });

  const accounts = connector.accounts;
  const chainId = connector.connectedChainId;
  const address = connector.address;

  const wrongNetwork =
    connected &&
    expectedChainId != null &&
    chainId != null &&
    String(chainId).toLowerCase() !== String(expectedChainId).toLowerCase();

  const refreshWallets = async () => {
    setState((s) => ({ ...s, localConnecting: true, localError: null }));
    try {
      const wallets = await connector.getAvailableWallets();
      setState({ localWallets: wallets, localConnecting: false, localError: null });
    } catch (e) {
      setState({
        localWallets: [],
        localConnecting: false,
        localError: e instanceof Error ? e : new Error(String(e)),
      });
    }
  };

  const handleConnect = async (walletId) => {
    try {
      await connector.connect({ walletId });
      await refreshWallets();
    } catch {}
  };

  const handleDisconnect = async (walletId) => {
    try {
      await connector.disconnect({ walletId });
      setState({ localWallets: [], localConnecting: false, localError: null });
    } catch {}
  };

  const renderError = () => {
    const msg =
      localError?.message ?? error?.message ?? "";
    if (!msg) return null;
    if (msg.includes("no installed wallet found")) {
      return (
        <p style={{ color: "var(--orange)", margin: 0, fontSize: 13 }}>
          No wallet found. Install a Starknet wallet that Rekaya supports, then try again.
        </p>
      );
    }
    if (msg.includes("more than one installed wallet")) {
      return (
        <p style={{ color: "var(--orange)", margin: 0, fontSize: 13 }}>
          More than one wallet is installed. Select one below, or pass walletId to connect().
        </p>
      );
    }
    return (
      <p style={{ color: "var(--orange)", margin: 0, fontSize: 13 }}>
        {msg}
      </p>
    );
  };

  if (children != null) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div className={className}>
      {/* connection state messaging */}
      {localConnecting && (
        <p style={{ color: "var(--dim)", margin: 0, fontSize: 13 }}>
          Connecting…
        </p>
      )}

      {wrongNetwork && (
        <p style={{ color: "var(--orange)", margin: 0, fontSize: 13 }}>
          Wrong network: wallet is on {ADDRESS_TRUNC(chainId)} — expected{" "}
          {ADDRESS_TRUNC(expectedChainId)}. Use a wallet on the correct network,
          or switch the wallet to the expected chain.
        </p>
      )}

      {(!connected) && renderError()}

      {connected && !wrongNetwork && (
        <p style={{ color: "var(--text)", margin: 0, fontSize: 13 }}>
          Connected · {ADDRESS_TRUNC(address)} · {ADDRESS_TRUNC(chainId)}
        </p>
      )}

      {/* wallet list */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: 8,
        }}
      >
        {localWallets.length === 0 &&
          !localConnecting &&
          !connected &&
          !localError && (
            <button
              type="button"
              style={{
                background: "var(--bg-2)",
                border: "1px solid var(--line)",
                color: "var(--dim)",
                padding: "10px 14px",
                textAlign: "left",
                fontSize: 13,
                cursor: "pointer",
              }}
              onClick={refreshWallets}
            >
              Refresh wallet list
            </button>
          )}

        {localWallets
          .slice()
          .sort((a, b) =>
            a.installed === b.installed ? 0 : a.installed ? -1 : 1
          )
          .map((w) => {
            const activeForThisWallet =
              connector.walletId != null &&
              w.id != null &&
              connector.walletId === w.id;

            const wantConnect =
              !activeForThisWallet && !connected && w.installed;
            const wantDisconnect = activeForThisWallet;

            return (
              <WalletWalletRow
                key={w.id}
                wallet={w}
                connecting={localConnecting}
                connected={connected}
                activeForThisWallet={activeForThisWallet}
                onConnect={() => handleConnect(w.id)}
                onDisconnect={() => handleDisconnect(w.id)}
              />
            );
          })}
      </div>

      {/* balance-read caveat (rendered once, before any balance read is triggered) */}
      {showBalanceCaveat && connected && (
        <p
          style={{
            color: "var(--dim)",
            fontSize: 12,
            margin: "10px 0 0",
            fontStyle: "italic",
          }}
        >
          When you check your balance, Rekaya will ask to share it with this dapp.
          Your keys never leave the wallet.
        </p>
      )}
    </div>
  );
}

/**
 * Single-row wallet button. Kept separate so WalletSelector stays readable.
 */
function WalletWalletRow({
  wallet,
  connecting,
  connected,
  activeForThisWallet,
  onConnect,
  onDisconnect,
}) {
  const wantConnect = !activeForThisWallet && !connected && wallet.installed;
  const wantDisconnect = activeForThisWallet;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {wallet.icon_url != null ? (
        <img
          src={wallet.icon_url}
          alt=""
          style={{ width: 24, height: 24, borderRadius: 4 }}
        />
      ) : (
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 4,
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
          }}
        />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 14,
            color: "var(--text)",
          }}
        >
          {wallet.name}
        </div>
        <div style={{ fontSize: 12, color: "var(--dim)" }}>
          {wallet.installed ? "installed" : "not installed"}
          {activeForThisWallet ? " · connected" : ""}
        </div>
      </div>

      <button
        type="button"
        disabled={
          connecting || !wallet.installed || (wantDisconnect && !connected)
        }
        style={{
          background:
            wantDisconnect && connected
              ? "var(--bg-2)"
              : wantConnect
              ? "var(--orange)"
              : "var(--bg-2)",
          color:
            wantDisconnect && connected
              ? "var(--orange)"
              : wantConnect
              ? "#fff"
              : "var(--dim)",
          border: "1px solid",
          borderColor:
            wantDisconnect && connected
              ? "var(--orange)"
              : wantConnect
              ? "var(--orange)"
              : "var(--line)",
          padding: "8px 14px",
          fontSize: 13,
          fontWeight: 600,
          cursor:
            connecting || !wallet.installed
              ? "not-allowed"
              : wantDisconnect
              ? "pointer"
              : "pointer",
          minWidth: 96,
          textAlign: "center",
        }
        onClick={
          connecting
            ? undefined
            : wantConnect
            ? onConnect
            : wantDisconnect
            ? onDisconnect
            : undefined
        }
      >
        {connecting
          ? "connecting…"
          : wantDisconnect
          ? "Disconnect"
          : wantConnect
          ? "Connect"
          : connected
          ? "Connected"
          : "Unavailable"}
      </button>
    </div>
  );
}

// ---- named export for consumers that only need to discover wallets ----

/**
 * Convenience: available wallets without a full hook. Useful for scripts,
 * QA, or a one-shot "do we have any wallet?" check.
 *
 * @param {string} [rekayaEndpoint]
 * @returns {Promise<{ id: string; name: string; installed: boolean; icon_url?: string }[]>}
 */
export async function discoverWallets({ rekayaEndpoint } = {}) {
  const c = new RekayaKitConnector({
    projectId: "rhizome",
    rekayaEndpoint: rekayaEndpoint ?? DEFAULT_REKAYA_ENDPOINT,
  });
  return c.getAvailableWallets();
}

// ---- re-export of React for consumers that need the module object ----

/**
 * The resolved React module (or null if React is not installed). Consumers
 * that need to access React directly can use this; in a React app it is the
 * real react module.
 *
 * @type {import("react") | null}
 */
export { React };
