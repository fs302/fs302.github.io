---
layout: post
title: 图学习之链路预测模型总结
description: 将 GNN 链路预测模型分成 Node-Based、Subgraph-Based、Propagation 三类，简要总结每种方法的特点，方便检索和参考。
category: tech
---

## Node-Based

### Node2Vec/MetaPath2Vec

![n2v](images/gnnlink/n2v.png)

Transductive 图表征算法，基于同构图或异构图结构，将相连的节点映射到相似的向量空间。由于表征信息主要是基于路径可达、结构相似，该方法生成的表征对于结构依赖性较高的网络会有更好的链路预测效果。

### GCN/R-GCN

![GCN](images/gnnlink/gcn.png)

Inductive 节点表征模型，基于节点对的邻居信息得到两个节点的表征后，融合两个表征向量来计算链接的形成概率。以 GAE(Graph AutoEncoder) 为例：

$$\widehat{A}_{i, j}=\sigma\left(z_i^T z_j\right), \text { where } z_i=Z_i, Z=G C N(X, A)$$

通过最小化重构矩阵与原始邻接矩阵的差值来优化模型。由于表征信息主要来源于邻居的特征聚合，该方法生成的表征对于内容相似性形成连边的网络有更好的预测效果。

### LinearRE

![LinearRE](images/gnnlink/LinearRE.png)

LineaRE[3]（Linear Regression Embedding）模型适用于 Knowledge Graph 上的 link prediction，其理论是将关系看作原实体与目标实体间的 linear mapping，学习 linear regrassion的权重，得到一个关系打分模型：

$$f_r({h}, {t})=\left\|{w}_r^{\mathbf{1}} \circ {h}+{b}_r-{w}_r^{\mathbf{2}} \circ {t}\right\|_1$$

本质上这个方法和 Trans 系列表征是属于同一类，只是用了更复杂的建模映射。

### ComHG [ICLR2023]

![ComHG](images/gnnlink/ComHG.png)

ComHG[11] 即 Combining link Heuristics and the GNN，这个模型简单地融合了启发式的链路预测指标和节点粒度的 GCN，使得模型同时具备了刻画结构相似性和内容相似性的能力。在 OGB 的几个数据集上表现都不菲，优于 SEAL 和 SUREL。作者特别强调了 ComHG 在计算上很友好，因为它能同时兼顾节点 GNNs 的高效和启发式指标的快速计算。

## Subgraph-Based

### SEAL [NeuIPS2018]

![SEAL](images/gnnlink/SEAL.png)

SEAL[1] 是为链路预测任务量身定制的 GNN 算法框架，目标是预测 (u,v) 是否存在 Missing Link 或者 Future Link，其核心可以拆分成 3 个主要模块：

- 子图提取（Enclosing subgraph）
- 节点标记（Node labeling）
- GNN 分类器

前两个模块是 SEAL 成功的重要设计，子图提取限定了目标节点对 (u,v) 的邻域子图，对应启发式链路预测中的 CN、AA 等 local-index，节点标记是对子图中的节点进行了重要性排序，从而让与目标 link 更近的点发挥更大的作用。

### GraIL [ICML2020]

![GraIL](images/gnnlink/GraIL.png)

GraIL[2] 是 SEAL 在知识图谱或异构图上的一种扩展，目标是判断 (u,v) 是否存在 r 类型的关系，其与 SEAL 的主要区别是 enclosing subgraph 部分采用了两个节点 n-hop 邻居的交集而非并集。同时，GraIL 的打分模块更综合，融合了子图 Embedding、源节点 u 的 Embedding、目标节点 v 的 Embedding 和边特征 Embedding，即：

$$\operatorname{score}\left(u, r_t, v\right)=\mathbf{W}^T\left[\mathbf{h}_{\mathcal{G}_{\left(u, v, r_t\right)}^L} \oplus \mathbf{h}_u^L \oplus \mathbf{h}_v^L \oplus \mathbf{e}_{r_t}\right]$$

### LGLP [TPAMI2020]

![LGLP](images/gnnlink/LGLP.png)

LGLP[4] 参考 SEAL 的一个变体，在子图抽取和节点标记之后，将子图点边转换，变换成 Line Graph 后直接用 GCN 的点分类来建模边的似然性。这个方法相比直接把全图做 Line Graph 的好处是点边转换后的规模膨胀不那么明显！作者在万级节点的小数据集上测试，效果优于 SEAL。

### SUREL [VLDB2022]

![SUREL](images/gnnlink/SUREL.png)

SUREL[7] 是 SEAL 原作者在工程优化上做的一次尝试，主要思路是将节点的位置编码前置到预处理过程，当 Query {u,v} 提交时，只需要进行一个简单的特征提取后接一个简单的 NN 即可得到 link 评分。由于预处理可以并行化，SUREL 比 SEAL 快 10 倍以上，当 p=16 时，最快可以提升 5000 倍 (36h->26s)。

具体的，在 Preprocessing 阶段，通过 Walk Sampling 为每个节点生成 M 个长度为 m 的随机游走序列，通过节点在每个序列中的位置统计并 hash 映射到更小的空间。在 Query 阶段，把 {u,v} 子图提取出来后，直接查找 hash 表拿到每个节点的预编码 X_u和X_v，再经过一个 NN 得到 {u,v} 的表征。

### WalkPool [ICLR2022]

![WalkPool](images/gnnlink/WalkPool.png)

WalkPool[8] 继续延续了 SEAL 的子图提取后做图分类的思路，而与 SEAL 对节点做重要性标记不同的是，WalkPool 在特征构建过程中基于子图的条件转移概率矩阵 P 生成了大量启发式的结构特征（统称为 Walk-Profiles），作者称其为可训练的启发式模型（Trainable Heuristics），取得了优于 SEAL 的预测效果。

首先为目标 link (u,v) 抽取 k-hop 的子图，然后分别为目标 link 存在和不存在的两种情况分别计算 random-walk profiles，包括节点级、链接级、子图级 3 种特征，最后将 walk profile 喂给 link classifier，最终的模型输入为：

$$\mathrm{WP}_\theta(G, \mathbf{Z})=\left[\omega_{1,2},\left(\text { node }^{\tau,+}, \text { node }^{\tau,-}, \text { link }^{\tau,+}, \text { link }^{\tau,-}, \Delta \operatorname{graph}^\tau\right)_{\tau=2}^{\tau_c}\right]$$

### ScaLed [CIKM2022]

![ScaLed](images/gnnlink/ScaLed.png)

ScaLed[9] 是对 SEAL 在运行效率上的改进，其主要贡献是利用 RandomWalk 对 (u,v) 周边子图进行采样，使得运行时间相比 SEAL 降低一半以上。

### ELPH [ICLR2023]

![ELPH](images/gnnlink/ELPH.png)

这是 Twitter Graph ML 团队的工作，作者声称解决了 GNN 在链路预测问题上的几个困难问题。文章[10]中对 SEAL 等 SGNN 进行了消融实验分析，提出了 ELPH (Efficient Link Prediction with Hashes) & BUDDY，其中 ELPH 是一个 MPNN 模型，通过将子图速写（sketches）传导到消息中，使得模型可以更好预估高阶关联关系，且拥有和 GCN 一样的效率。而 BUDDY 则是进一步将 ELPH 的 hash 过程预处理，从而可以用在更大规模的图上。

## Propagation

### PaGNN [PKDD2021]

![PaGNN](images/gnnlink/PaGNN.png)

PaGNN[5] 模型包含两个主要的操作：broadcasting操作和aggregation操作。第一步，对于需要预测的链路中的两个节点，broadcasting操作从其中一个节点出发，将节点特征传播到与其相连的直接邻居，并融合直接邻居和传播边上的信息。第二步，需要通过aggregation操作，将邻居信息聚合到链路中的另一个节点中，与之前GNN的aggregation操作相比，除了需要聚合邻居本身的信息，还需要聚合之前broadcasting操作生成的信息。

PaGNN 会针对 (u,v) 节点对做来回两次双向的传播，拼接后得到最终表征。

$$\mathbf{s}_{u, v}=\left[\mathbf{r}_{u, v}^H, \mathbf{r}_{v, u}^H\right] $$

### NBFNet [NeurIPS2021]

![NBFNet](images/gnnlink/NBFNet.png)

NBFNet[6] 是 Bellman-Ford的GNN版，通过一次性计算单源节点的 n-hop 邻居表征，利用了局部 cache，相比Pair-wise计算可提升链路预测的效率。作者在文章中提到对于 FB15K-237 数据集，NBFNet 的运行时间是 4 分钟，相比 RGCN 慢 6 倍，但是比 GraIL 快 1 万倍。在同构图上的模型表现与 SEAL 基本一致，在异构图上的表现与 GraIL 基本一致。

## 参考文献

1. M. Zhang and Y. Chen, Link Prediction Based on Graph Neural Networks, Advances in Neural Information Processing Systems (NIPS-18). [[PDF]](https://arxiv.org/pdf/1802.09691.pdf)
2. Komal K. Teru and Etienne Denis and William L. Hamilton, Inductive Relation Prediction by Subgraph Reasoning. (ICML2020) [[PDF]](https://arxiv.org/pdf/1911.06962.pdf)
3. Yanhui Peng and Jing Zhang, LineaRE: Simple but Powerful Knowledge Graph Embedding for Link Prediction (ICDM2020) [[PDF]](https://arxiv.org/pdf/2004.10037.pdf)
4. Lei Cai, Jundong Li, Jie Wang and Shuiwang Ji. Line Graph Neural Networks for Link Prediction(TPAMI2020) [[PDF]](https://arxiv.org/pdf/2010.10046.pdf)
5. Shuo Yang, Binbin Hu, Zhiqiang Zhang, Wang Sun, Yang Wang, Hongyu Shan, Jun Zhou ? , Yuetian Cao, Borui Ye, and Yanming Fang. Inductive Link Prediction with Interactive Structure Learning on Attributed Graph. (PKDE2021) [[PDF]](https://2021.ecmlpkdd.org/wp-content/uploads/2021/07/sub_635.pdf)
6. Zhaocheng Zhu, Zuobai Zhang, Louis-Pascal Xhonneux, Jian Tang. Neural Bellman-Ford Networks: A General Graph Neural Network Framework for Link Prediction. (NeurIPS 2021) [[PDF]](https://arxiv.org/pdf/2106.06935.pdf)
7. Haoteng Yin, Muhan Zhang, Yanbang Wang, Jianguo Wang, & Pan Li . Algorithm and System Co-design for Efficient Subgraph-based Graph Representation Learning. (VLDB2022) [[PDF]](https://arxiv.org/pdf/2202.13538.pdf)
8. Liming Pan, Cheng Shi, & Ivan Dokmani\\'c. Neural Link Prediction with Walk Pooling Learning. (ICLR2022) [[PDF]](https://arxiv.org/pdf/2110.04375.pdf)
9. Paul Louis, Shweta Ann Jacob, & Amirali Salehi-Abari. Sampling Enclosing Subgraphs for Link Prediction. (CIKM2022) [[PDF]](https://arxiv.org/pdf/2206.12004.pdf)
10. Benjamin Paul Chamberlain, Sergey Shirobokov, Emanuele Ross, Fabrizio Frasca, Thomas Markovich, Nils Hammerla, Michael M. Bronstein, & Max Hansmire. Graph Neural Networks for Link Prediction with Subgraph Sketching. [[PDF]](https://arxiv.org/pdf/2209.15486.pdf)
11. Can GNNs Learn Heuristic Information for Link Prediction? [[PDF]](https://openreview.net/pdf?id=_lnFErG3F1z)