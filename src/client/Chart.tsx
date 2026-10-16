import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import type { EChartsOption, ECharts } from 'echarts';

export function Chart(p: { option: () => EChartsOption; height?: number; label: string }) {
  let element!: HTMLDivElement;
  let chart: ECharts | undefined;
  let disposed = false;
  const [ready, setReady] = createSignal(false);
  onMount(() => {
    const observer = new ResizeObserver(() => chart?.resize());
    observer.observe(element);
    void import('echarts').then(ec => {
      if (disposed) return;
      chart = ec.init(element, undefined, { renderer: 'canvas' });
      setReady(true);
    });
    onCleanup(() => { disposed = true; observer.disconnect(); chart?.dispose(); });
  });
  createEffect(() => {
    if (!ready()) return;
    chart?.setOption({ backgroundColor: 'transparent', animation: false, textStyle: { fontFamily: 'Inter, Segoe UI, sans-serif', color: '#829093' }, ...p.option() }, { notMerge: true });
  });
  return <div ref={element} class="chart" style={{ height: `${p.height ?? 280}px`, width: '100%' }} role="img" aria-label={p.label}/>;
}
export const chartGrid = { top: 24, right: 20, bottom: 36, left: 60 };
export const axisStyle = { axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: '#20282c' } }, axisLabel: { color: '#738086', fontSize: 10 } };
