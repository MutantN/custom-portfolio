import React from "react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

export default function EfficientFrontierChart({
  frontier,
  minVarChartPoint,
  maxSharpeChartPoint,
  trueMinVarPoint,
}) {
  return (
    <ResponsiveContainer width="100%" height={310}>
      <ScatterChart margin={{ top: 36, right: 20, bottom: 56, left: 50 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="x" type="number" name="Vol" unit="%" domain={["auto", "auto"]} tick={{ fontSize: 11, fill: "#64748b" }} label={{ value: "Volatility (%)", position: "bottom", offset: 18, fontSize: 12, fill: "#64748b" }} />
        <YAxis dataKey="y" type="number" name="Ret" unit="%" domain={["auto", "auto"]} tick={{ fontSize: 11, fill: "#64748b" }} label={{ value: "Return (%)", angle: -90, position: "insideLeft", fontSize: 12, fill: "#64748b" }} />
        <Tooltip formatter={(v) => `${Number(v).toFixed(2)}%`} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }} />
        <Legend verticalAlign="top" align="right" wrapperStyle={{ fontSize: 12, top: 0, right: 8 }} />
        <Scatter name="Random" data={frontier} fill="#cbd5e1" fillOpacity={0.35} />
        <Scatter name="Best Min Variance (by Sharpe)" data={minVarChartPoint ? [minVarChartPoint] : []} fill="#10b981" shape="diamond" stroke="#065f46" strokeWidth={2} />
        <Scatter name="Best Max Sharpe" data={maxSharpeChartPoint ? [maxSharpeChartPoint] : []} fill="#f59e0b" shape="star" stroke="#92400e" strokeWidth={2} />
        <Scatter name="True Min Variance" data={trueMinVarPoint ? [trueMinVarPoint] : []} fill="#3b82f6" shape="circle" stroke="#1e40af" strokeWidth={2} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
