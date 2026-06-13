const form = document.querySelector("#contractForm");
const chart = document.querySelector("#bidChart");

const state = {
  bundle: null,
};

const formatMoney = (value) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);

const formatPercent = (value) => `${(value * 100).toFixed(2)}%`;

function setText(id, text) {
  document.querySelector(`#${id}`).textContent = text;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function quantile(values, p) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function normalizeBidType(value) {
  const map = {
    BID: "投标",
    low_price: "投标",
    NEG: "谈判",
    EVALUATED: "评估",
    QUOTE: "报价",
  };
  return map[value] || value || "投标";
}

function readContract() {
  const data = new FormData(form);
  return {
    quantity: Number(data.get("quantity")),
    model_raw: String(data.get("model_raw") || ""),
    bus_length_ft: Number(data.get("bus_length_ft")),
    fuel_type: String(data.get("fuel_type")),
    floor_type: String(data.get("floor_type")),
    bid_type: normalizeBidType(String(data.get("bid_type"))),
    region: String(data.get("region") || "").trim(),
    bid_year: Number(data.get("bid_year")),
    bid_month: Number(data.get("bid_month")),
    orion_est_cost: Number(data.get("orion_est_cost")),
    competitor_count: Number(data.get("competitor_count")),
    pricing_goal: String(data.get("pricing_goal") || "profit"),
  };
}

function parseModelFeatures(contract) {
  const modelText = (contract.model_raw || "").toUpperCase();
  const lengthMatch = modelText.match(/(\d{2})/);
  const busLength = Number.isFinite(contract.bus_length_ft) && contract.bus_length_ft > 0
    ? contract.bus_length_ft
    : Number(lengthMatch?.[1] || 0);
  return {
    ...contract,
    bus_length_ft: busLength,
    floor_type: contract.floor_type || (modelText.includes("LF") ? "LF" : modelText.includes("HF") ? "HF" : "UNK"),
    fuel_type:
      contract.fuel_type ||
      (modelText.includes("CNG")
        ? "CNG"
        : modelText.includes("HYB")
          ? "Hyb"
          : /\bD\b/.test(modelText)
            ? "D"
            : "Other"),
    has_vi: modelText.includes("VI") ? 1 : 0,
    has_sub: modelText.includes("SUB") ? 1 : 0,
  };
}

function transformFeatures(preprocessor, row) {
  const numeric = preprocessor.numeric_features.map((feature, index) => {
    const raw = Number(row[feature]);
    const filled = Number.isFinite(raw) ? raw : preprocessor.numeric_medians[index];
    const scale = preprocessor.numeric_scales[index] || 1;
    return (filled - preprocessor.numeric_means[index]) / scale;
  });

  const categorical = [];
  preprocessor.categorical_features.forEach((feature, featureIndex) => {
    const value = String(row[feature] ?? preprocessor.categorical_fill_values[featureIndex]);
    preprocessor.categorical_levels[featureIndex].forEach((level) => {
      categorical.push(value === level ? 1 : 0);
    });
  });

  return [...numeric, ...categorical];
}

function predictRidge(modelBundle, row) {
  const features = transformFeatures(modelBundle.preprocessor, row);
  let prediction = modelBundle.intercept;
  for (let i = 0; i < features.length; i += 1) {
    prediction += features[i] * modelBundle.coefficients[i];
  }
  return prediction;
}

function predictForestProbability(modelBundle, row) {
  const features = Float32Array.from(transformFeatures(modelBundle.preprocessor, row));
  let total = 0;

  modelBundle.trees.forEach((tree) => {
    let node = 0;
    while (tree.feature[node] >= 0) {
      node = features[tree.feature[node]] <= tree.threshold[node] ? tree.children_left[node] : tree.children_right[node];
    }
    total += tree.prob_class_1[node];
  });

  return total / modelBundle.trees.length;
}

function buildDirectCandidates(contract, predictedMarketPrice) {
  const points = state.bundle.candidate_grid_points || 61;
  const low = Math.max(contract.orion_est_cost * 1.02, predictedMarketPrice * 0.88);
  const high = Math.max(low + 1, predictedMarketPrice * 1.12);
  const candidates = [];

  for (let i = 0; i < points; i += 1) {
    const bid = low + ((high - low) * i) / (points - 1);
    const enriched = {
      ...contract,
      orion_bid_price: bid,
      markup_ratio: (bid - contract.orion_est_cost) / contract.orion_est_cost,
      market_gap_ratio: (bid - predictedMarketPrice) / predictedMarketPrice,
    };
    const winProbability = predictForestProbability(state.bundle.win_probability_model, enriched);
    candidates.push({
      bid_price: bid,
      win_probability: winProbability,
      markup_ratio: enriched.markup_ratio,
      expected_profit: winProbability * (bid - contract.orion_est_cost) * contract.quantity,
    });
  }

  return candidates;
}

function buildReferenceCandidates(contract, predictedReferencePrice) {
  const residuals = state.bundle.reference_price_model.residuals;
  const points = state.bundle.candidate_grid_points || 61;
  const low = Math.max(contract.orion_est_cost * 1.02, predictedReferencePrice * 0.88);
  const high = Math.max(low + 1, predictedReferencePrice * 1.12);
  const candidates = [];

  for (let i = 0; i < points; i += 1) {
    const bid = low + ((high - low) * i) / (points - 1);
    const winProbability = residuals.filter((residual) => predictedReferencePrice + residual >= bid).length / residuals.length;
    candidates.push({
      bid_price: bid,
      win_probability: winProbability,
      markup_ratio: (bid - contract.orion_est_cost) / contract.orion_est_cost,
      expected_profit: winProbability * (bid - contract.orion_est_cost) * contract.quantity,
    });
  }

  return candidates;
}

function pickBest(candidates, field) {
  return candidates.reduce((best, item) => (item[field] > best[field] ? item : best), candidates[0]);
}

function calculate(contract) {
  const enriched = parseModelFeatures(contract);
  const predictedMarketPrice = predictRidge(state.bundle.winning_price_model, enriched);
  const predictedReferencePrice = predictRidge(state.bundle.reference_price_model.pipeline, enriched);

  const directCandidates = buildDirectCandidates(enriched, predictedMarketPrice);
  const referenceCandidates = buildReferenceCandidates(enriched, predictedReferencePrice);

  const bestByWinProbability = pickBest(directCandidates, "win_probability");
  const bestByExpectedProfit = pickBest(directCandidates, "expected_profit");
  const directFeasible60 = directCandidates.some((item) => item.win_probability >= 0.6);

  const residualQ40 =
    state.bundle.reference_price_model.residual_q40 ??
    quantile(state.bundle.reference_price_model.residuals, 0.4);
  const referenceTargetBid = predictedReferencePrice + residualQ40;
  const referenceTarget = {
    bid_price: referenceTargetBid,
    win_probability: 0.6,
    markup_ratio: (referenceTargetBid - enriched.orion_est_cost) / enriched.orion_est_cost,
    expected_profit: 0.6 * (referenceTargetBid - enriched.orion_est_cost) * enriched.quantity,
  };
  const referenceBestProfit = pickBest(referenceCandidates, "expected_profit");

  let selected = bestByExpectedProfit;
  let selectedLabel = "利润优先推荐";
  if (contract.pricing_goal === "win_probability") {
    selected = bestByWinProbability;
    selectedLabel = "市占率优先推荐";
  } else if (contract.pricing_goal === "target_60_low_price") {
    selected = referenceTarget;
    selectedLabel = "价低者得下的 60% 目标报价";
  }

  return {
    predictedMarketPrice,
    predictedReferencePrice,
    directCandidates,
    referenceCandidates,
    bestByWinProbability,
    bestByExpectedProfit,
    referenceTarget,
    referenceBestProfit,
    residualQ40,
    directFeasible60,
    selected,
    selectedLabel,
  };
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

function renderComparison(result, contract) {
  const items = [
    {
      title: "中标概率最高",
      item: result.bestByWinProbability,
      text: "适合抢订单、冲市占率，通常需要让价更多。",
      recommended: contract.pricing_goal === "win_probability",
    },
    {
      title: "期望利润最高",
      item: result.bestByExpectedProfit,
      text: "经营层面的默认首选，兼顾利润与胜率。",
      recommended: contract.pricing_goal === "profit",
    },
    {
      title: "60% 目标报价",
      item: result.referenceTarget,
      text:
        contract.bid_type === "投标"
          ? "按参考价口径反推得到，适用于价低者得项目。"
          : "仅作价格下界参考，综合评估项目不宜把它当成胜率承诺。",
      recommended: contract.pricing_goal === "target_60_low_price",
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
  const selected = result.selected;
  const marketGap = (selected.bid_price - result.predictedMarketPrice) / result.predictedMarketPrice;
  const riskLevel = selected.win_probability >= 0.5 ? "较低" : selected.win_probability >= 0.25 ? "中等" : "偏高";
  const referenceGap = result.referenceTarget.bid_price - result.predictedReferencePrice;

  setText("adviceBid", formatMoney(selected.bid_price));
  setText("riskLevel", riskLevel);
  setText(
    "riskText",
    contract.pricing_goal === "target_60_low_price"
      ? "该方案按参考价口径把报价压至 60% 目标位置，适合标准低价竞争项目。"
      : `当前推荐报价相对预测市场价${marketGap >= 0 ? "高" : "低"} ${formatPercent(Math.abs(marketGap))}。`,
  );
  setText(
    "adviceReason",
    contract.pricing_goal === "target_60_low_price"
      ? `预测竞争参考价为 ${formatMoney(result.predictedReferencePrice)}，残差 40% 分位点为 ${formatMoney(result.residualQ40)}，因此 60% 目标报价约为 ${formatMoney(result.referenceTarget.bid_price)}。`
      : `${result.selectedLabel}下，推荐报价为 ${formatMoney(selected.bid_price)}，预计中标概率 ${formatPercent(selected.win_probability)}，期望利润 ${formatMoney(selected.expected_profit)}。`,
  );
  setText(
    "formulaText",
    contract.pricing_goal === "target_60_low_price"
      ? "bid_60 = predicted reference price + q40(residual)"
      : "Expected Profit = P(win | bid) × (bid - cost) × quantity",
  );

  document.querySelector("#adviceList").innerHTML = `
    <li>直接模型预测市场中标价约为 ${formatMoney(result.predictedMarketPrice)}，参考价模型预测竞争参考价约为 ${formatMoney(result.predictedReferencePrice)}。</li>
    <li>中标概率最高报价为 ${formatMoney(result.bestByWinProbability.bid_price)}，对应胜率 ${formatPercent(result.bestByWinProbability.win_probability)}。</li>
    <li>期望利润最高报价为 ${formatMoney(result.bestByExpectedProfit.bid_price)}，对应期望利润 ${formatMoney(result.bestByExpectedProfit.expected_profit)}。</li>
    <li>若按价低者得并追求 60% 中标率，参考价口径给出的报价为 ${formatMoney(result.referenceTarget.bid_price)}，比预测参考价低 ${formatMoney(Math.abs(referenceGap))}。</li>
    <li>${result.directFeasible60 ? "直接中标概率模型下存在不低于 60% 的候选报价。" : "直接中标概率模型下，不存在达到 60% 中标率的可行报价。"} </li>
  `;
}

function render() {
  if (!state.bundle) {
    return;
  }

  const contract = readContract();
  const result = calculate(contract);
  const selected = result.selected;

  setText("marketPrice", formatMoney(result.predictedMarketPrice));
  setText("bestBid", formatMoney(selected.bid_price));
  setText("bestProbability", formatPercent(selected.win_probability));
  setText("bestProfit", formatMoney(selected.expected_profit));
  setText("bestBidLabel", result.selectedLabel);
  setText(
    "bestProbabilityLabel",
    contract.pricing_goal === "target_60_low_price" ? "参考价口径下设定为 60%" : "第二层：RandomForest 中标率估计",
  );
  setText(
    "bestProfitLabel",
    contract.pricing_goal === "target_60_low_price" ? "0.6 × 利润 × 数量" : "P(win) × 利润 × 数量",
  );

  const chartCandidates = contract.pricing_goal === "target_60_low_price" ? result.referenceCandidates : result.directCandidates;
  drawChart(chartCandidates, selected);
  renderComparison(result, contract);
  renderAdvice(contract, result);
}

function applyDefaults(defaults) {
  Object.entries(defaults).forEach(([key, value]) => {
    const field = form.elements.namedItem(key);
    if (field) {
      field.value = String(value);
    }
  });
}

async function init() {
  try {
    const response = await fetch("./web_model_bundle.json");
    state.bundle = await response.json();
    applyDefaults(state.bundle.defaults);
    render();
  } catch (error) {
    console.error(error);
    setText("adviceReason", "模型工件加载失败，请检查 web_model_bundle.json 是否已部署。");
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  render();
});

form.addEventListener("input", () => {
  render();
});

init();
