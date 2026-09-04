import { Input } from "antd";
import { SearchIcon } from "./icons";

/**
 * The table screens' search field. Every screen had a character-identical copy
 * of this thirteen-line block, differing only in the placeholder.
 *
 * Dumb on purpose — the debounce, the trim and the last-request-wins guard all
 * live in usePagedList. Spread its `searchProps` in, the same way `tableProps`
 * is spread onto <Table>:
 *
 *     <SearchBox placeholder={t("search.device")} {...list.searchProps} />
 */
export function SearchBox({
  placeholder,
  value,
  onChange,
  onPressEnter,
  width = 320,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onPressEnter: () => void;
  width?: number;
}) {
  return (
    <div className="screen-search">
      <Input
        allowClear
        prefix={<SearchIcon size={16} />}
        placeholder={placeholder}
        style={{ width }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPressEnter={onPressEnter}
      />
    </div>
  );
}
