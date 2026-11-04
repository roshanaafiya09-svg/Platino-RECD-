"use client";

import { Bar, Doughnut } from "react-chartjs-2";
import { Chart as ChartJS, BarElement, ArcElement, CategoryScale, LinearScale, Tooltip } from "chart.js";

ChartJS.register(BarElement, ArcElement, CategoryScale, LinearScale, Tooltip);

interface ChartProps {
  labels: string[];
  values: number[];
  colors: string[];
}

export function PhaseBarChart({ labels, values, colors }: ChartProps) {
  return (
    <Bar
      data={{
        labels,
        datasets: [{ data: values, backgroundColor: colors, borderRadius: 6, maxBarThickness: 40 }],
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          y: { display: false, beginAtZero: true },
        },
      }}
    />
  );
}

export function ComplaintDoughnut({ labels, values, colors }: ChartProps) {
  return (
    <Doughnut
      data={{
        labels,
        datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }],
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        cutout: "68%",
        plugins: { legend: { display: false } },
      }}
    />
  );
}
