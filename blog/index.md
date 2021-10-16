---
layout: home
---

<div class="index-content tech">
    <div class="section">
        <ul class="artical-cate">
           <li class="on"><a href="/blog"><span>Tech</span></a></li>
            <li><a href="/blog/life"><span>Life</span></a></li>
            <li><a href="/blog/project"><span>Project</span></a></li>
			<li><a href="/blog/shine"><span>Shine</span></a></li>
        </ul>

        <div class="cate-bar"><span id="cateBar"></span></div>

        <ul class="artical-list">
        {% for post in site.categories.tech %}
            <li>
                <h2><a href="{{ post.url }}">{{ post.title }}</a></h2>
                <div class="title-desc">{{ post.description }}</div>
            </li>
        {% endfor %}
        </ul>
    </div>
    <div class="aside">
    </div>
</div>
