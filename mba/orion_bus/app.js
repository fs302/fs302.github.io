const form = document.querySelector("#contractForm");
const chart = document.querySelector("#bidChart");

const formatMoney = (value) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);

const formatPercent = (value) => `${(value * 100).toFixed(2)}%`;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function readContract() {
  const data = new FormData(form);
  return {
    quantity: Number(data.get("quantity")),
    model_raw: String(data.get("model_raw") || ""),
    bus_length_ft: Number(data.get("bus_length_ft")),
    fuel_type: String(data.get("fuel_type")),
    floor_type: String(data.get("floor_type")),
    bid_type: String(data.get("bid_type")),
    region: String(data.get("region")),
    bid_year: Number(data.get("bid_year")),
    bid_month: Number(data.get("bid_month")),
    orion_est_cost: Number(data.get("orion_est_cost")),
  };
}

function predictMarketPrice(contract) {
  const modelText = contract.model_raw.toUpperCase();
  let markup = 0.098;

  markup += (contract.bus_length_ft - 30) * 0.0032;
  markup += contract.fuel_type === "CNG" || modelText.includes("CNG") ? 0.037 : 0;
  markup += contract.floor_type === "LF" || modelText.includes("LF") ? 0.022 : 0;

  const bidAdjustments = {
    BID: -0.006,
    NEG: 0.018,
    EVALUATED: 0.034,
    QUOTE: 0.012,
    low_price: -0.012,
  };

  const regionAdjustments = {
    West: 0.011,
    East: 0.004,
    South: -0.003,
    North: 0.002,
    CA: 0.013,
    WA: 0.01,
    NC: -0.004,
  };

  markup += bidAdjustments[contract.bid_type] || 0;
  markup += regionAdjustments[contract.region] || 0;
  markup += (contract.bid_year - 2002) * 0.006;
  markup += (contract.bid_month - 6) * 0.0008;

  return contract.orion_est_cost * (1 + clamp(markup, 0.045, 0.32));
}

function predictWinProbability(contract, bidPrice, predictedMarketPrice) {
  const gap = (bidPrice - predictedMarketPrice) / predictedMarketPrice;
  const markup = (bidPrice - contract.orion_est_cost) / contract.orion_est_cost;
  const evaluationBonus = contract.bid_type === "EVALUATED" || contract.bid_type === "NEG" ? 0.055 : 0;
  const lowPricePenalty = contract.bid_type === "low_price" || contract.bid_type === "BID" ? -0.018 : 0;
  const complexityPenalty = contract.fuel_type === "CNG" && contract.floor_type === "LF" ? -0.01 : 0;
  const raw = 1 / (1 + Math.exp(10.5 * gap + 1.7 * markup - 0.16));

  return clamp(raw + evaluationBonus + lowPricePenalty + complexityPenalty, 0.025, 0.92);
}

function buildCandidates(contract, predictedMarketPrice) {
  const rows = [];
  const steps = 180;
  const minMarkup = 0.02;
  const maxMarkup = 0.35;

  for (let i = 0; i < steps; i += 1) {
    const markup = minMarkup + ((maxMarkup - minMarkup) * i) / (steps - 1);
    const bid = contract.orion_est_cost * (1 + markup);
    const winProbability = predictWinProbability(contract, bid, predictedMarketPrice);
    const unitProfit = bid - contract.orion_est_cost;
    const totalProfitIfWin = unitProfit * contract.quantity;

    rows.push({
      bid_price: bid,
      markup_ratio: markup,
      win_probability: winProbability,
      unit_profit: unitProfit,
      total_profit_if_win: totalProfitIfWin,
      expected_profit: winProbability * totalProfitIfWin,
    });
  }

  return rows;
}

function pickBest(candidates, field) {
  return candidates.reduce((best, item) => (item[field] > best[field] ? item : best), candidates[0]);
}

function calculate(contract) {
  const predictedMarketPrice = predictMarketPrice(contract);
  const candidates = buildCandidates(contract, predictedMarketPrice);
  return {
    predictedMarketPrice,
    candidates,
    bestByWinProbability: pickBest(candidates, "win_probability"),
    bestByExpectedProfit: pickBest(candidates, "expected_profit"),
    bestByMargin: pickBest(candidates, "markup_ratio"),
  };
}

function setText(id, text) {
  document.querySelector(`#${id}`).textContent = text;
}

function pathFor(points) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

function drawChart(candidates, best) {
  const width = 760;
  const height = 320;
  const padding = { top: 24, right: 26, bottom: 42, left: 62 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const minBid = Math.min(...candidates.map((d) => d.bid_price));
  const maxBid = Math.max(...candidates.map((d) => d.bid_price));
  const maxProfit = Math.max(...candidates.map((d) => d.expected_profit));
  const maxProbability = Math.max(...candidates.map((d) => d.win_probability));

  const x = (bid) => padding.left + ((bid - minBid) / (maxBid - minBid)) * innerWidth;
  const yProfit = (profit) => padding.top + innerHeight - (profit / maxProfit) * innerHeight;
  const yProbability = (probability) => padding.top + innerHeight - (probability / maxProbability) * innerHeight;

  const profitPoints = candidates.map((d) => ({ x: x(d.bid_price), y: yProfit(d.expected_profit) }));
  const probabilityPoints = candidates.map((d) => ({ x: x(d.bid_price), y: yProbability(d.win_probability) }));
  const bestX = x(best.bid_price);
  const bestY = yProfit(best.expected_profit);

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const y = padding.top + innerHeight * ratio;
      return `<line class="grid-line" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" />`;
    })
    .join("");

  const ticks = [minBid, (minBid + maxBid) / 2, maxBid]
    .map((value) => {
      const tx = x(value);
      return `<text class="tick-label" x="${tx}" y="${height - 16}" text-anchor="middle">${formatMoney(value)}</text>`;
    })
    .join("");

  chart.innerHTML = `
    ${grid}
    <text class="axis-label" x="${padding.left}" y="16">期望利润 / 中标概率</text>
    <text class="axis-label" x="${width - padding.right}" y="${height - 16}" text-anchor="end">候选报价</text>
    <path class="line-profit" d="${pathFor(profitPoints)}"></path>
    <path class="line-probability" d="${pathFor(probabilityPoints)}"></path>
    <line x1="${bestX}" y1="${padding.top}" x2="${bestX}" y2="${height - padding.bottom}" stroke="rgba(255,116,104,.38)" stroke-width="2" stroke-dasharray="5 7" />
    <circle cx="${bestX}" cy="${bestY}" r="8" fill="#ff7468" stroke="#fff2df" stroke-width="3" />
    <text class="tick-label" x="${bestX + 12}" y="${bestY - 12}">推荐点</text>
    ${ticks}
  `;
}

function renderComparison(result) {
  const items = [
    {
      title: "中标概率最高",
      item: result.bestByWinProbability,
      text: "适合抢订单、填满产能，但利润空间较低。",
    },
    {
      title: "期望利润最高",
      item: result.bestByExpectedProfit,
      text: "同时平衡胜率和利润，是经营决策首选。",
      recommended: true,
    },
    {
      title: "利润率最高",
      item: result.bestByMargin,
      text: "适合作为报价上限参考，直接采用容易丢单。",
    },
  ];

  document.querySelector("#comparisonTable").innerHTML = items
    .map(
      ({ title, item, text, recommended }) => `
        <article class="compare-card ${recommended ? "recommended" : ""}">
          <span>${title}</span>
          <strong>${formatMoney(item.bid_price)}</strong>
          <p>加价率 ${formatPercent(item.markup_ratio)} · 胜率 ${formatPercent(item.win_probability)}</p>
          <p>${text}</p>
        </article>
      `,
    )
    .join("");
}

function renderAdvice(contract, result) {
  const best = result.bestByExpectedProfit;
  const marketGap = (best.bid_price - result.predictedMarketPrice) / result.predictedMarketPrice;
  let riskLevel = "中等";
  let riskText = "推荐报价在利润与中标概率之间保持平衡。";

  if (best.win_probability < 0.1) {
    riskLevel = "偏高";
    riskText = "中标概率较低，适合利润优先策略；如公司急需订单，可改看中标概率最高报价。";
  } else if (best.win_probability > 0.25) {
    riskLevel = "较低";
    riskText = "中标概率相对稳健，报价仍保留一定利润空间。";
  }

  setText("adviceBid", formatMoney(best.bid_price));
  setText("riskLevel", riskLevel);
  setText("riskText", riskText);
  setText(
    "adviceReason",
    `建议报价比预测市场中标价${marketGap >= 0 ? "高" : "低"} ${formatPercent(Math.abs(marketGap))}，预计可获得 ${formatMoney(best.expected_profit)} 的期望利润。`,
  );

  document.querySelector("#adviceList").innerHTML = `
    <li>若公司目标是经营绩效最大化，采用期望利润最高报价 ${formatMoney(best.bid_price)}。</li>
    <li>若客户明确低价优先，可把报价下调至 ${formatMoney(result.bestByWinProbability.bid_price)} 附近以提高胜率。</li>
    <li>若这是战略客户或后续订单入口，建议将中标概率作为更高权重。</li>
    <li>本合同数量为 ${contract.quantity} 辆，单车成本 ${formatMoney(contract.orion_est_cost)}，总利润对报价变化较敏感。</li>
  `;
}

function render() {
  const contract = readContract();
  const result = calculate(contract);
  const best = result.bestByExpectedProfit;

  setText("marketPrice", formatMoney(result.predictedMarketPrice));
  setText("bestBid", formatMoney(best.bid_price));
  setText("bestProbability", formatPercent(best.win_probability));
  setText("bestProfit", formatMoney(best.expected_profit));

  drawChart(result.candidates, best);
  renderComparison(result);
  renderAdvice(contract, result);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  render();
});

form.addEventListener("input", () => {
  render();
});

render();
