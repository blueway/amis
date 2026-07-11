import React, {startTransition} from 'react';
import {ITableStore, themeable, ThemeProps} from 'amis-core';
import {getScrollParent} from 'amis-core';
import {resizeSensor} from 'amis-core';
import type {IRow} from 'amis-core/lib/store/table';

export interface VirtualTableBodyProps extends ThemeProps {
  className?: string;
  store: ITableStore;
  prefixRows?: React.ReactNode[];
  affixRows?: React.ReactNode[];
  dataRows: IRow[];
  renderRow: (item: IRow, rowIndex: number) => React.ReactNode | React.ReactNode[];
}

function getRowHeight(
  prefixRows: React.ReactNode[],
  dataRows: IRow[],
  affixRows: React.ReactNode[],
  prefixLen: number,
  affixLen: number,
  i: number,
  fallback: number
): number {
  if (i < prefixLen) {
    const row = prefixRows[i] as React.ReactElement;
    return row?.props?.item?.height || fallback;
  }
  const dataIdx = i - prefixLen;
  if (dataIdx < dataRows.length) {
    return dataRows[dataIdx]?.height || fallback;
  }
  const affixIdx = dataIdx - dataRows.length;
  if (affixIdx < affixLen) {
    const row = affixRows[affixIdx] as React.ReactElement;
    return row?.props?.item?.height || fallback;
  }
  return fallback;
}

function getRowItem(
  prefixRows: React.ReactNode[],
  dataRows: IRow[],
  affixRows: React.ReactNode[],
  prefixLen: number,
  affixLen: number,
  i: number
): {item?: IRow; rowSpans?: Record<string, number>} {
  if (i < prefixLen) {
    const row = prefixRows[i] as React.ReactElement;
    return row?.props?.item || {};
  }
  const dataIdx = i - prefixLen;
  if (dataIdx < dataRows.length) {
    return dataRows[dataIdx];
  }
  const affixIdx = dataIdx - dataRows.length;
  if (affixIdx < affixLen) {
    const row = affixRows[affixIdx] as React.ReactElement;
    return row?.props?.item || {};
  }
  return {};
}

function VirtualTableBody(props: VirtualTableBodyProps) {
  const {
    className,
    store,
    classPrefix,
    prefixRows = [],
    affixRows = [],
    dataRows,
    renderRow
  } = props;
  const leadingPlaceholderRef = React.useRef<HTMLTableSectionElement>(null);
  const trailingPlaceholderRef = React.useRef<HTMLTableSectionElement>(null);
  const tBodyRef = React.useRef<HTMLTableSectionElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const itemHeight = React.useRef(44);
  const sizeRef = React.useRef(20);

  const buffer = 20;
  const prefixLen = prefixRows.length;
  const affixLen = affixRows.length;
  const totalLen = prefixLen + dataRows.length + affixLen;

  const [from, to] = React.useMemo(() => {
    let from = 0;
    let offsetHeight = 0;

    for (let i = 0; i < totalLen; i++) {
      const height = getRowHeight(
        prefixRows,
        dataRows,
        affixRows,
        prefixLen,
        affixLen,
        i,
        itemHeight.current
      );
      if (offsetHeight + height > scrollTop) {
        break;
      }
      offsetHeight += height;
      from++;
    }

    from = Math.max(0, from - buffer);
    let to = Math.min(from + sizeRef.current + buffer * 2, totalLen);

    if (store.combineNum) {
      while (from > 0) {
        const {rowSpans} = getRowItem(
          prefixRows,
          dataRows,
          affixRows,
          prefixLen,
          affixLen,
          from
        );
        if (
          rowSpans &&
          Object.values(rowSpans).some((v: number) => v === 0)
        ) {
          from--;
          continue;
        }
        break;
      }
      let index = to;
      for (; index >= from; index--) {
        const {rowSpans} = getRowItem(
          prefixRows,
          dataRows,
          affixRows,
          prefixLen,
          affixLen,
          index
        );
        if (rowSpans) {
          const maxSpan = Math.max(
            1,
            ...(Object.values(rowSpans) as number[])
          );
          if (maxSpan > 1) {
            to = Math.max(to, index + maxSpan);
          }
        }
      }
    }
    return [from, to];
  }, [prefixRows, dataRows, prefixLen, totalLen, scrollTop, store.combineNum]);

  const [visibleRows, offsetHeight, totalHeight, virtualHeight] =
    React.useMemo(() => {
      let offsetHeight = 0;
      let totalHeight = 0;
      let virtualHeight = 0;

      for (let i = 0; i < totalLen; i++) {
        const height = getRowHeight(
          prefixRows,
          dataRows,
          affixRows,
          prefixLen,
          affixLen,
          i,
          itemHeight.current
        );
        totalHeight += height;
        if (i < from) {
          offsetHeight += height;
        } else if (i <= to) {
          virtualHeight += height;
        }
      }

      const result: React.ReactNode[] = [];
      for (let i = from; i < to && i < totalLen; i++) {
        if (i < prefixLen) {
          result.push(prefixRows[i]);
        } else if (i < prefixLen + dataRows.length) {
          const dataIdx = i - prefixLen;
          const rendered = renderRow(dataRows[dataIdx], dataIdx);
          if (Array.isArray(rendered)) {
            result.push(...rendered);
          } else {
            result.push(rendered);
          }
        } else {
          const affixIdx = i - prefixLen - dataRows.length;
          if (affixIdx < affixLen) {
            result.push(affixRows[affixIdx]);
          }
        }
      }
      return [result, offsetHeight, totalHeight, virtualHeight];
    }, [prefixRows, affixRows, dataRows, renderRow, prefixLen, affixLen, totalLen, from, to]);

  React.useEffect(() => {
    const tbody = tBodyRef.current!;
    const table = tbody.parentElement!;
    const wrap = table.parentElement!;
    const rootDom = wrap.closest(`.${classPrefix}Table`)!;

    const fixedHeader = rootDom?.querySelector(`:scope > .${classPrefix}Table-fixedTop`);
    const header = fixedHeader || table.querySelector(':scope > thead')!;
    const firstRow = leadingPlaceholderRef.current!;
    const isAutoFill = rootDom.classList.contains(
      `${classPrefix}Table--autoFillHeight`
    );
    const toDispose: Array<() => void> = [];
    const check = () => {
      let scrollTop = 0;
      if (fixedHeader) {
        const rect = header.getBoundingClientRect();
        const rect2 = firstRow.getBoundingClientRect();
        scrollTop = rect.bottom - rect2.top;
      } else {
        const scrollContainer: any = isAutoFill ? wrap :
          (getScrollParent(rootDom as HTMLElement) === document.body
            ? document.documentElement
            : getScrollParent(rootDom as HTMLElement));
        scrollTop = scrollContainer.scrollTop || 0;
      }
      startTransition(() => setScrollTop(scrollTop));
      if (scrollTop && store.tableLayout !== 'fixed') {
        store.switchToFixedLayout();
      }
    };
    let timer: ReturnType<typeof requestAnimationFrame> | null = null;
    const lazyCheck = () => {
      timer && cancelAnimationFrame(timer);
      timer = requestAnimationFrame(check);
    };

    if (isAutoFill) {
      wrap.addEventListener('scroll', lazyCheck);
      toDispose.push(() => wrap.removeEventListener('scroll', lazyCheck));
    } else {
      let scrollContainer: HTMLElement | Document = getScrollParent(
        rootDom as HTMLElement
      ) as HTMLElement | Document;
      scrollContainer =
        scrollContainer === document.body ? document : scrollContainer;
      scrollContainer.addEventListener('scroll', lazyCheck);
      toDispose.push(() =>
        scrollContainer.removeEventListener('scroll', lazyCheck)
      );
    }

    toDispose.push(
      resizeSensor(wrap, () => {
        const trs = [].slice.apply(tbody.querySelectorAll(':scope > tr')!);
        trs.forEach((tr: any) => {
          const id = tr.getAttribute('data-id');
          const item = store.getItemById(id);
          if (!item) {
            return;
          }
          itemHeight.current = tr.offsetHeight;
          item.setHeight(itemHeight.current!);
        });

        sizeRef.current = Math.min(
          Math.ceil(
            Math.min(isAutoFill ? wrap.clientHeight : window.innerHeight) /
              itemHeight.current
          ),
          40
        );
        check();
      })
    );

    return () => {
      toDispose.forEach(fn => fn());
      toDispose.length = 0;
    };
  }, []);

  const styles: any = {
    '--Table-scroll-height': `${totalHeight}px`,
    '--Table-scroll-offset': `${offsetHeight}px`,
    '--Table-frame-height': `${virtualHeight}px`
  };

  return (
    <>
      <tbody style={styles} className="virtual-table-body-placeholder leading">
        <tr>
          <td colSpan={store.filteredColumns.length}>
            <div ref={leadingPlaceholderRef}></div>
          </td>
        </tr>
      </tbody>
      <tbody className={className} ref={tBodyRef}>
        {visibleRows}
      </tbody>
      <tbody style={styles} className="virtual-table-body-placeholder trailing">
        <tr>
          <td colSpan={store.filteredColumns.length}>
            <div ref={trailingPlaceholderRef}></div>
          </td>
        </tr>
      </tbody>
    </>
  );
}

export default themeable(VirtualTableBody);
