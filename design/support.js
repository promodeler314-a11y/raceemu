/**
 * `design/*.dc.html` をブラウザで直接開くための実行時。
 *
 * `.dc.html` は Claude Design のキャンバス用の形式で、キャンバスの中では
 * 編集器が持つ実行時（dc-runtime）が描いている。ファイルを `file://` で
 * じかに開いたときはその実行時がいないので、各ファイルが読んでいる
 * `./support.js` が無いと `DCLogic is not defined` で止まる。
 * このファイルがその欠けている口を埋める。
 *
 * **本家の実行時の移植ではなく、モックが実際に使っている機能だけの実装である。**
 * `design/*.dc.html` が期待しているのは次の 5 つだけで、ここではそれを満たす。
 *
 * 1. `DCLogic` が大域にあること（`class Component extends DCLogic` が素の
 *    `<script>` として走るので、body の解析より前に居なければならない）。
 * 2. `state` フィールドと `setState(部分)` と `renderVals()`。
 * 3. `<x-dc>` の中身をテンプレートとして描くこと。
 * 4. `<helmet>` の中身（`<link>` と `<style>`）を `document.head` に移すこと。
 * 5. 属性値とテキストの `{{ 名前 }}` を `renderVals()` の値で埋め、
 *    `onClick="{{ 関数 }}"` を click の handler に繋ぐこと。
 *
 * 本家の実行時にある繰り返し（`<x-for>`）、部品の読み込み（`<x-import>`）、
 * 差分描画、編集器との postMessage は**入れていない**。モックが使っていないためで、
 * 使い始めたらここを足すことになる。
 *
 * 外部に何も依存しない。本家の実行時は React を CDN から読むが、
 * モックはビルド段を持たずブラウザで直接開くものなので、ここでは読み込みを足さない
 * （書体だけは各 `.dc.html` が CDN から読んでいる。issue #49）。
 */
(function () {
  'use strict';

  /* ── {{ 名前 }} の解決 ───────────────────────────────────── */

  /** `{{ … }}` を捕獲付きで分ける。split に渡すと 奇数番目が中身になる。 */
  var INTERP = /\{\{([\s\S]+?)\}\}/g;

  /** 先頭の識別子。 */
  var IDENT = /^[A-Za-z_$][\w$]*/;

  /** 原型を辿らせない。`{{ constructor }}` のような指定を値なしにする。 */
  var BLOCKED = { __proto__: true, constructor: true, prototype: true };

  /**
   * `{{ }}` の中身を `vals` の上で辿る。
   *
   * 式ではなく経路だけを見る（`a.b`、`a[0]`、`a[b]`）。
   * 辿れなければ `undefined` を返す。
   */
  function resolve(vals, expr) {
    // モックは `{{ themeMode }}` のように空白を挟んで書く。前後を落としてから辿る。
    var rest = String(expr).trim();
    var head = rest.match(IDENT);
    if (head === null) return undefined;
    if (BLOCKED[head[0]] === true) return undefined;
    var cur = vals === null || vals === undefined ? undefined : vals[head[0]];
    var i = head[0].length;
    while (i < rest.length) {
      if (rest[i] === '.') {
        var tail = rest.slice(i + 1);
        var m = tail.match(IDENT) || tail.match(/^\d+/);
        if (m === null || BLOCKED[m[0]] === true) return undefined;
        cur = cur === null || cur === undefined ? undefined : cur[m[0]];
        i += 1 + m[0].length;
      } else if (rest[i] === '[') {
        var depth = 1;
        var j = i + 1;
        while (j < rest.length && depth > 0) {
          if (rest[j] === '[') depth++;
          else if (rest[j] === ']') {
            depth--;
            if (depth === 0) break;
          }
          j++;
        }
        if (depth !== 0) return undefined;
        var key = resolve(vals, rest.slice(i + 1, j));
        cur = cur === null || cur === undefined ? undefined : cur[key];
        i = j + 1;
      } else if (rest[i] === ' ') {
        i++;
      } else {
        return undefined;
      }
    }
    return cur;
  }

  /**
   * 属性値やテキストを、値を受け取ると文字列（または値そのもの）を返す関数にする。
   *
   * 全体が 1 つの `{{ }}` のときは値をそのまま返す。
   * `onClick="{{ setDark }}"` が関数を受け取れるのはこのためである。
   */
  function compile(raw) {
    var whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
    if (whole !== null) {
      return function (vals) {
        return resolve(vals, whole[1]);
      };
    }
    if (raw.indexOf('{{') === -1) {
      return function () {
        return raw;
      };
    }
    var parts = raw.split(INTERP);
    return function (vals) {
      var out = '';
      for (var i = 0; i < parts.length; i++) {
        if ((i & 1) === 0) {
          out += parts[i];
          continue;
        }
        var v = resolve(vals, parts[i]);
        if (v === undefined || v === null || typeof v === 'boolean') continue;
        out += String(v);
      }
      return out;
    };
  }

  /* ── 基底クラス ─────────────────────────────────────────── */

  /**
   * モックの `class Component extends DCLogic` が継承する基底。
   *
   * `renderVals()` が返した平たいオブジェクトがテンプレートの値になる。
   * `setState` は差分を混ぜて描き直す。
   */
  function DCLogic(props) {
    this.props = props || {};
    this.state = {};
    /** 描き直しの口。boot が差し込む。 */
    this.__rerender = null;
  }
  DCLogic.prototype.setState = function (update, cb) {
    var patch = typeof update === 'function' ? update(this.state, this.props) : update;
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) this.state[k] = patch[k];
    }
    if (this.__rerender !== null) this.__rerender();
    if (typeof cb === 'function') cb();
  };
  DCLogic.prototype.forceUpdate = function () {
    if (this.__rerender !== null) this.__rerender();
  };
  DCLogic.prototype.componentDidMount = function () {};
  DCLogic.prototype.componentDidUpdate = function () {};
  DCLogic.prototype.componentWillUnmount = function () {};
  DCLogic.prototype.renderVals = function () {
    return {};
  };

  // 素の `<script>` の中の `class Component extends DCLogic` は、body が解析される
  // 時点で `DCLogic` を引く。head で読まれるこのファイルが先に置いておく。
  // `StreamableLogic` は本家の実行時での実装名で、どちらでも継承できるようにしておく。
  window.DCLogic = DCLogic;
  window.StreamableLogic = DCLogic;

  /* ── 属性から event へ ──────────────────────────────────── */

  /** DOM は属性名を小字にするので、`onClick` は `onclick` として届く。 */
  function eventTypeOf(attrName) {
    if (attrName.slice(0, 2) !== 'on') return null;
    var rest = attrName.slice(2);
    if (rest === '') return null;
    if (rest === 'doubleclick') return 'dblclick';
    return rest;
  }

  /* ── 走査 ───────────────────────────────────────────────── */

  /**
   * `<x-dc>` の下を 1 度だけ歩いて、`{{ }}` を持つ場所を覚える。
   *
   * 描き直しでは覚えた場所だけを書き換える。木を作り直さないので、
   * 入力欄に入れた値や、開いている `<details>` がダークの切替で消えない。
   */
  function collect(root, bindings, handlers) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    var node = root.nodeType === 1 ? root : walker.nextNode();
    while (node !== null) {
      if (node.nodeType === 3) {
        if (node.nodeValue.indexOf('{{') !== -1) {
          bindings.push({ kind: 'text', node: node, get: compile(node.nodeValue) });
        }
      } else {
        // 属性は取りながら消すので、先に控えを取る。
        var attrs = [];
        for (var i = 0; i < node.attributes.length; i++) {
          attrs.push({ name: node.attributes[i].name, value: node.attributes[i].value });
        }
        for (var j = 0; j < attrs.length; j++) {
          var name = attrs[j].name;
          var value = attrs[j].value;
          if (value.indexOf('{{') === -1) continue;
          var type = eventTypeOf(name);
          if (type !== null) {
            // `onclick="{{ setDark }}"` を素の属性のまま残すと、ブラウザが
            // `{{ setDark }}` を JavaScript として組み立てようとして構文誤りになる。
            // 属性を消してから listener として繋ぐ。
            node.removeAttribute(name);
            handlers.push({ node: node, type: type, get: compile(value) });
          } else {
            bindings.push({ kind: 'attr', node: node, name: name, get: compile(value) });
          }
        }
      }
      node = walker.nextNode();
    }
  }

  /** 覚えた場所に値を流す。 */
  function apply(bindings, vals) {
    for (var i = 0; i < bindings.length; i++) {
      var b = bindings[i];
      var v = b.get(vals);
      if (b.kind === 'text') {
        b.node.nodeValue = v === undefined || v === null ? '' : String(v);
      } else if (v === undefined || v === null || v === false) {
        b.node.removeAttribute(b.name);
      } else if (typeof v !== 'function') {
        b.node.setAttribute(b.name, v === true ? '' : String(v));
      }
    }
  }

  /* ── 起動 ───────────────────────────────────────────────── */

  /** `<helmet>` の中身を head に移し、helmet 自体を外す。 */
  function hoistHelmet(root) {
    var helmets = root.querySelectorAll('helmet');
    for (var i = 0; i < helmets.length; i++) {
      while (helmets[i].firstChild !== null) document.head.appendChild(helmets[i].firstChild);
      helmets[i].remove();
    }
  }

  /** `data-props` から props と `$preview` を取り出す。 */
  function parseProps(raw) {
    if (raw === null || raw === '') return { props: {}, preview: null };
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn('[support.js] data-props が JSON として読めない:', e);
      return { props: {}, preview: null };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { props: {}, preview: null };
    }
    var props = {};
    for (var k in parsed) {
      if (Object.prototype.hasOwnProperty.call(parsed, k) && k[0] !== '$') props[k] = parsed[k];
    }
    var preview = parsed.$preview !== undefined && parsed.$preview !== null ? parsed.$preview : null;
    return { props: props, preview: preview };
  }

  /**
   * `<script data-dc-script>` の中身から `Component` を取り出す。
   *
   * 素の `<script>`（`type` の無いもの）はブラウザが先に走らせているが、
   * `class` の宣言は大域の語彙環境に入るだけで `window` には乗らない。
   * `type="text/x-dc"` のものはそもそも走っていない。
   * どちらも同じに扱えるよう、本文をここで評価し直してクラスを受け取る。
   */
  function evalLogic(src) {
    /* eslint-disable no-new-func */
    var factory = new Function(
      'DCLogic',
      'StreamableLogic',
      src + '\n;return (typeof Component !== "undefined" && Component) || undefined;',
    );
    return factory(DCLogic, DCLogic);
  }

  function boot() {
    var dc = document.querySelector('x-dc');
    if (dc === null) return;

    var scriptEl = document.querySelector('script[data-dc-script]');
    var parsed = parseProps(scriptEl === null ? null : scriptEl.getAttribute('data-props'));

    hoistHelmet(dc);

    // `<x-dc>` は素通しの入れ物なので、中身を持った `#dc-root` に置き換える。
    var host = document.createElement('div');
    host.id = 'dc-root';
    while (dc.firstChild !== null) host.appendChild(dc.firstChild);
    dc.replaceWith(host);

    // `$preview` を持つ面は自分で寸法を決めている。持たない面だけ全面に伸ばす。
    if (parsed.preview === null) {
      var full = document.createElement('style');
      full.textContent = 'html,body{height:100%;margin:0}#dc-root,#dc-root>*{height:100%}';
      document.head.appendChild(full);
    }

    var bindings = [];
    var handlers = [];
    collect(host, bindings, handlers);

    var Component = null;
    if (scriptEl !== null) {
      try {
        Component = evalLogic(scriptEl.textContent || '');
      } catch (e) {
        console.error('[support.js] <script data-dc-script> の評価に失敗した:', e);
      }
    }

    var logic = typeof Component === 'function' ? new Component(parsed.props) : new DCLogic(parsed.props);
    logic.props = parsed.props;
    if (logic.state === undefined || logic.state === null) logic.state = {};

    var vals = {};
    function render() {
      var next = logic.renderVals() || {};
      vals = {};
      for (var a in parsed.props) {
        if (Object.prototype.hasOwnProperty.call(parsed.props, a)) vals[a] = parsed.props[a];
      }
      for (var b in next) {
        if (Object.prototype.hasOwnProperty.call(next, b)) vals[b] = next[b];
      }
      apply(bindings, vals);
    }
    logic.__rerender = render;

    for (var i = 0; i < handlers.length; i++) {
      (function (hb) {
        hb.node.addEventListener(hb.type, function (ev) {
          var fn = hb.get(vals);
          if (typeof fn === 'function') fn(ev);
        });
      })(handlers[i]);
    }

    render();
    logic.componentDidMount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
