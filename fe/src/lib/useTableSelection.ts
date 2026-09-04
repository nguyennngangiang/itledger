import { useEffect, useState } from "react";

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
 */
export function useTableSelection(...resetOn: unknown[]) {
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  useEffect(() => {
    setSelectedKeys([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetOn);

  return {
    selectedKeys,
    setSelectedKeys,
    clear: () => setSelectedKeys([]),
    rowSelection: {
      selectedRowKeys: selectedKeys,
      onChange: (keys: React.Key[]) => setSelectedKeys(keys as string[]),
    },
  };
}
