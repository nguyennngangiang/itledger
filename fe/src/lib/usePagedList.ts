import { useCallback, useEffect, useRef, useState } from "react";
import type { TablePaginationConfig } from "antd";
import { toast } from "react-toastify";
import type { Paged, PageParams } from "../api/paging";
import { useLoading } from "../hook/LoadingContext";
import { useT } from "../i18n/useT";

export type SortOrder = "asc" | "desc";

/** Typing pause before a search actually goes to the server. */
const SEARCH_DEBOUNCE_MS = 300;

type Options = {
  defaultOrderBy?: string;
  defaultOrder?: SortOrder;
  status?: string; // device lifecycle, or employee active/retired
  noTeam?: boolean; // employees only — those with no department
  refreshKey?: number; // bump to force reload (e.g. after a create)
  pageSize?: number;
};

/**
 * Drives a server-side paginated / sortable / searchable Ant Table.
 * Returns rows/total plus `tableProps` to spread onto <Table>, and
 * search/trash controls. The fetcher may be an inline arrow (kept in a ref).
 *
 * Searching happens as you type, which forces two things that did not matter when
 * only Enter searched:
 *
 *  * **Last request wins.** Keystrokes overlap requests, and without a sequence
 *    guard a slow early response can land after a fast later one and put stale rows
 *    under a newer query.
 *  * **Two kinds of loading.** The full-screen cat overlay is right for "the page is
 *    loading" but wrong for "you typed another letter" — it would blink on every
 *    debounce tick and block the very input being typed into. Search-driven loads
 *    are `silent` and surface as the table's own spinner (`tableProps.loading`).
 */
export function usePagedList<T>(
  fetcher: (p: PageParams) => Promise<Paged<T>>,
  opts: Options = {},
) {
  const { defaultOrderBy, defaultOrder = "asc", status, noTeam, refreshKey } = opts;

  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(opts.pageSize ?? 20);
  const [orderBy, setOrderBy] = useState<string | undefined>(defaultOrderBy);
  const [order, setOrder] = useState<SortOrder>(defaultOrder);
  const [q, setQ] = useState("");
  const [trashed, setTrashed] = useState(false);

  const [tableLoading, setTableLoading] = useState(false);

  const { startLoading, endLoading } = useLoading();
  const { t } = useT();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Monotonic request id: a response is only applied if no newer request started.
  const seq = useRef(0);
  // Set by search() so the load its state change triggers skips the overlay.
  const silentNext = useRef(false);

  const load = useCallback(async (silent = false) => {
    const mine = ++seq.current;
    if (silent) setTableLoading(true);
    else startLoading();
    try {
      const res = await fetcherRef.current({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        orderBy,
        order,
        deleted: trashed,
        q: q || undefined,
        status,
        noTeam,
      });
      if (mine !== seq.current) return; // superseded — drop the stale answer
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      if (mine === seq.current) console.error(e);
    } finally {
      // Only the newest request may clear the indicator, or an early response
      // would turn it off while a later request is still in flight.
      if (mine === seq.current) {
        if (silent) setTableLoading(false);
        else endLoading();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, orderBy, order, q, trashed, status, noTeam]);

  useEffect(() => {
    load(silentNext.current);
    silentNext.current = false;
  }, [load, refreshKey]);

  // Reset to first page when an external filter changes.
  const firstStatus = useRef(true);
  useEffect(() => {
    if (firstStatus.current) {
      firstStatus.current = false;
      return;
    }
    setPage(1);
  }, [status, noTeam]);

  // Search: applied without the overlay, and back to the first page.
  const applyNow = useCallback((value: string) => {
    silentNext.current = true;
    setQ(value);
    setPage(1);
  }, []);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPending = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  /** As-you-type search. Clearing the box applies at once — waiting to see all
   *  your rows come back reads as lag, not as debounce. */
  const search = useCallback(
    (value: string) => {
      cancelPending();
      if (!value) {
        applyNow("");
        return;
      }
      timer.current = setTimeout(() => applyNow(value), SEARCH_DEBOUNCE_MS);
    },
    [applyNow],
  );

  /** Enter skips the wait. */
  const searchNow = useCallback(
    (value: string) => {
      cancelPending();
      applyNow(value);
    },
    [applyNow],
  );

  useEffect(() => cancelPending, []);
  const toggleTrash = async (value: boolean) => {
    // Opening the trash: don't bother (and don't play the open animation) when
    // there's nothing in it. Closing always proceeds.
    if (value) {
      try {
        const res = await fetcherRef.current({
          limit: 1,
          offset: 0,
          orderBy,
          order,
          deleted: true,
          q: q || undefined,
          status,
        });
        if (!res.total) {
          toast.info(t("trash.empty"));
          return;
        }
      } catch (e) {
        console.error(e);
      }
    }
    setTrashed(value);
    setPage(1);
  };

  const onTableChange = (
    pagination: TablePaginationConfig,
    _filters: unknown,
    sorter: any,
  ) => {
    if (pagination.current) setPage(pagination.current);
    if (pagination.pageSize) setPageSize(pagination.pageSize);
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    if (s?.order) {
      setOrderBy(s.field as string);
      setOrder(s.order === "ascend" ? "asc" : "desc");
    } else {
      setOrderBy(defaultOrderBy);
      setOrder(defaultOrder);
    }
  };

  const tableProps = {
    dataSource: rows,
    onChange: onTableChange,
    loading: tableLoading,
    pagination: {
      current: page,
      pageSize,
      total,
      showSizeChanger: true,
      pageSizeOptions: ["10", "20", "50", "100"],
      showTotal: (total: number, range: [number, number]) =>
        t("paging.range", { from: range[0], to: range[1], n: total }),
    } as TablePaginationConfig,
  };

  return {
    rows,
    total,
    q,
    trashed,
    search,
    searchNow,
    toggleTrash,
    reload: () => load(false),
    tableProps,
  };
}
