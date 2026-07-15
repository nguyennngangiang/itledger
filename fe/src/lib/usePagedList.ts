import { useCallback, useEffect, useRef, useState } from "react";
import type { TablePaginationConfig } from "antd";
import { toast } from "react-toastify";
import type { Paged, PageParams } from "../api/paging";
import { useLoading } from "../hook/LoadingContext";

export type SortOrder = "asc" | "desc";

type Options = {
  defaultOrderBy?: string;
  defaultOrder?: SortOrder;
  status?: string; // devices status filter
  refreshKey?: number; // bump to force reload (e.g. after a create)
  pageSize?: number;
};

/**
 * Drives a server-side paginated / sortable / searchable Ant Table.
 * Returns rows/total plus `tableProps` to spread onto <Table>, and
 * search/trash controls. The fetcher may be an inline arrow (kept in a ref).
 */
export function usePagedList<T>(
  fetcher: (p: PageParams) => Promise<Paged<T>>,
  opts: Options = {},
) {
  const { defaultOrderBy, defaultOrder = "asc", status, refreshKey } = opts;

  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(opts.pageSize ?? 20);
  const [orderBy, setOrderBy] = useState<string | undefined>(defaultOrderBy);
  const [order, setOrder] = useState<SortOrder>(defaultOrder);
  const [q, setQ] = useState("");
  const [trashed, setTrashed] = useState(false);

  const { startLoading, endLoading } = useLoading();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async () => {
    startLoading();
    try {
      const res = await fetcherRef.current({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        orderBy,
        order,
        deleted: trashed,
        q: q || undefined,
        status,
      });
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      console.error(e);
    } finally {
      setTimeout(endLoading, 120);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, orderBy, order, q, trashed, status]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  // Reset to first page when the external status filter changes.
  const firstStatus = useRef(true);
  useEffect(() => {
    if (firstStatus.current) {
      firstStatus.current = false;
      return;
    }
    setPage(1);
  }, [status]);

  // Search box (Enter): apply query, jump back to first page.
  const applySearch = (value: string) => {
    setQ(value);
    setPage(1);
  };
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
          toast.info("Trash is empty");
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
    pagination: {
      current: page,
      pageSize,
      total,
      showSizeChanger: true,
      pageSizeOptions: ["10", "20", "50", "100"],
      showTotal: (t: number, range: [number, number]) =>
        `${range[0]}–${range[1]} of ${t}`,
    } as TablePaginationConfig,
  };

  return {
    rows,
    total,
    q,
    trashed,
    applySearch,
    toggleTrash,
    reload: load,
    tableProps,
  };
}
