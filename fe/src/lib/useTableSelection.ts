import { useState } from "react";

const NOTHING: string[] = [];

/**
 * Row selection for a table screen: the keys, the object <Table> wants, and one
 * rule about when a selection is thrown away.
 *
 * Each screen used to hand-roll this, and the rule had drifted: Devices cleared
 * on `[trashed, statusFilter]`, Maintenance and Handovers only on `[trashed]`,
 * and Employees cleared in two event handlers instead of an effect — so its
 * selection survived a filter change that removed the selected rows from view,
 * and a bulk delete could then act on rows the user could no longer see.
 *
 * Pass whatever changes the visible set:
 *
 *     const sel = useTableSelection(list.trashed, statusFilter);
 *     <Table rowSelection={sel.rowSelection} … />
 *
 * The reset is DERIVED, not performed. Keys are stored alongside the filters they
 * were picked under, and a selection made under different filters simply does not
 * count. Clearing them in an effect instead left one render where the filter had
 * already changed and the old selection was still live — which is the exact
 * window this hook exists to close.
 */
export function useTableSelection(...resetOn: unknown[]) {
  const token = JSON.stringify(resetOn);
  const [picked, setPicked] = useState<{ token: string; keys: string[] }>({
    token,
    keys: NOTHING,
  });

  // A shared constant rather than a fresh `[]`, so a stale selection does not
  // hand <Table> a new array identity on every render.
  const selectedKeys = picked.token === token ? picked.keys : NOTHING;
  const setSelectedKeys = (keys: string[]) => setPicked({ token, keys });

  return {
    selectedKeys,
    setSelectedKeys,
    clear: () => setSelectedKeys(NOTHING),
    rowSelection: {
      selectedRowKeys: selectedKeys,
      onChange: (keys: React.Key[]) => setSelectedKeys(keys as string[]),
    },
  };
}
