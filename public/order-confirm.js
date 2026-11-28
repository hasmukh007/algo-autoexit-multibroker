/**
 * Shared On-Page Order Confirmation Modal + Web Audio Bell Chime
 * Requires explicit user confirmation before any manual or algo-triggered order
 * is dispatched to a broker from Dashboard, Option Chain, or Chart pages.
 */
(function () {
  let audioCtx = null;
  let confirmChain = Promise.resolve();
  const activePendingIds = new Map(); // id -> { close }

  function ensureAudioContext() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    if (!audioCtx) {
      try {
        audioCtx = new AudioCtor();
      } catch (e) {
        return null;
      }
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  // Unlock browser AudioContext silently on any user interaction
  ['pointerdown', 'keydown', 'click'].forEach(evt => {
    window.addEventListener(evt, () => {
      ensureAudioContext();
    }, { passive: true, capture: true });
  });

  /**
   * Synthesize a clear two-strike trading alert bell chime via Web Audio API.
   */
  function playOrderBellSound() {
    const ctx = ensureAudioContext();
    if (!ctx) return false;
    try {
      const now = ctx.currentTime;
      const playStrike = (startTime, gainPeak) => {
        const harmonics = [
          { freq: 880, amp: 0.45, decay: 0.85 },
          { freq: 1318.5, amp: 0.30, decay: 0.75 },
          { freq: 1760, amp: 0.22, decay: 0.65 },
          { freq: 2637, amp: 0.12, decay: 0.45 }
        ];
        harmonics.forEach(h => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(h.freq, startTime);
          gain.gain.setValueAtTime(0.0001, startTime);
          gain.gain.exponentialRampToValueAtTime(gainPeak * h.amp, startTime + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, startTime + h.decay);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(startTime);
          osc.stop(startTime + h.decay + 0.05);
        });
      };

      playStrike(now + 0.01, 0.55);
      playStrike(now + 0.26, 0.45);
      return true;
    } catch (e) {
      return false;
    }
  }

  function ensureConfirmModalDom() {
    let backdrop = document.getElementById('globalOrderConfirmModal');
    if (backdrop) return backdrop;

    backdrop = document.createElement('div');
    backdrop.id = 'globalOrderConfirmModal';
    backdrop.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:99999',
      'display:none',
      'align-items:center',
      'justify-content:center',
      'background:rgba(2, 6, 23, 0.78)',
      'backdrop-filter:blur(4px)',
      'padding:16px'
    ].join(';');

    backdrop.innerHTML = `
      <div style="width:100%;max-width:460px;background:#0f172a;border:1px solid #334155;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,0.65);overflow:hidden;color:#e2e8f0;font-family:inherit;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #1e293b;background:#111827;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:20px;line-height:1;" aria-hidden="true">&#128276;</span>
            <div>
              <h3 id="gocTitle" style="margin:0;font-size:15px;font-weight:700;color:#fff;">Confirm Order Before Sending</h3>
              <div id="gocSubtitle" style="font-size:11px;color:#94a3b8;margin-top:2px;">Broker execution paused until you confirm</div>
            </div>
          </div>
          <button type="button" id="gocCloseBtn" style="background:none;border:none;color:#94a3b8;font-size:22px;cursor:pointer;line-height:1;">&times;</button>
        </div>
        <div style="padding:16px 18px;">
          <div id="gocBody" style="font-size:13px;line-height:1.65;"></div>
          <div id="gocReasonBox" style="display:none;margin-top:10px;padding:8px 10px;border-radius:6px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);color:#fbbf24;font-size:12px;"></div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;">
            <button type="button" id="gocCancelBtn" style="padding:9px 16px;border-radius:6px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;font-weight:600;cursor:pointer;">Cancel / Reject</button>
            <button type="button" id="gocConfirmBtn" style="padding:9px 18px;border-radius:6px;border:none;background:#10b981;color:#fff;font-weight:700;cursor:pointer;">Confirm &amp; Send Order</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function escapeHtml(str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Play bell sound and prompt confirmation on the page before sending an order.
   * Returns Promise<boolean>.
   */
  function confirmOrderBeforeSend(details = {}) {
    const runPrompt = () => new Promise(resolve => {
      const modal = ensureConfirmModalDom();
      const titleEl = document.getElementById('gocTitle');
      const subEl = document.getElementById('gocSubtitle');
      const bodyEl = document.getElementById('gocBody');
      const reasonEl = document.getElementById('gocReasonBox');
      const confirmBtn = document.getElementById('gocConfirmBtn');
      const cancelBtn = document.getElementById('gocCancelBtn');
      const closeBtn = document.getElementById('gocCloseBtn');

      const sideRaw = String(details.transactionType || details.side || 'B').toUpperCase();
      const isSell = sideRaw === 'S' || sideRaw === 'SELL';
      const sideLabel = isSell ? 'SELL' : 'BUY';
      const ot = String(details.orderType || 'MKT').toUpperCase();
      const qtyText = details.autoQuantity && !(Number(details.quantity) > 0)
        ? 'Auto from Balance'
        : String(details.quantity || '--');
      const priceText = ot === 'MKT'
        ? (Number(details.ltp) > 0 ? `MARKET (Ref LTP ₹${Number(details.ltp).toFixed(2)})` : 'MARKET')
        : `₹${Number(details.price || 0).toFixed(2)}`;
      const trigText = (ot === 'SL' || ot === 'SL-LMT' || Number(details.triggerPrice) > 0)
        ? `₹${Number(details.triggerPrice || 0).toFixed(2)}`
        : null;

      titleEl.textContent = details.title || 'Confirm Order Before Sending';
      subEl.textContent = details.sourceLabel || 'Review order details — nothing is sent to broker until confirmed';

      const rows = [
        ['Broker / Target', details.brokerLabel || details.routingLabel || details.accountId || 'Checked Broker'],
        ['Side', `<span style="padding:2px 8px;border-radius:4px;font-weight:700;background:${isSell ? 'rgba(239,68,68,0.18)' : 'rgba(16,185,129,0.18)'};color:${isSell ? '#f87171' : '#34d399'};">${sideLabel}</span>`],
        ['Symbol', `<strong>${escapeHtml(details.symbol || details.tradingSymbol || '--')}</strong>`],
        ['Product / Type', `${escapeHtml(details.product || 'MIS')} • ${escapeHtml(ot)}`],
        ['Quantity', `<strong class="mono">${escapeHtml(qtyText)}</strong>`],
        ['Price', `<strong class="mono">${escapeHtml(priceText)}</strong>`]
      ];
      if (trigText) {
        rows.push(['Trigger Price', `<strong class="mono">${escapeHtml(trigText)}</strong>`]);
      }

      bodyEl.innerHTML = rows.map(([k, v]) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #1e293b;">
          <span style="color:#94a3b8;">${escapeHtml(k)}:</span>
          <span>${v}</span>
        </div>
      `).join('');

      if (details.reason) {
        reasonEl.style.display = 'block';
        reasonEl.textContent = details.reason;
      } else {
        reasonEl.style.display = 'none';
        reasonEl.textContent = '';
      }

      confirmBtn.style.background = isSell ? '#ef4444' : '#10b981';
      confirmBtn.textContent = details.confirmText || `Confirm & Send ${sideLabel}`;

      let settled = false;
      const cleanup = result => {
        if (settled) return;
        settled = true;
        modal.style.display = 'none';
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        closeBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        if (details.pendingId) {
          activePendingIds.delete(details.pendingId);
        }
        resolve(result);
      };

      const onConfirm = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onKey = e => {
        if (e.key === 'Escape') cleanup(false);
      };

      if (details.pendingId) {
        activePendingIds.set(details.pendingId, { forceClose: () => cleanup(null) });
      }

      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      closeBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);

      modal.style.display = 'flex';
      playOrderBellSound();
    });

    confirmChain = confirmChain.then(runPrompt, runPrompt);
    return confirmChain;
  }

  async function handleServerPendingOrder(entry) {
    if (!entry || !entry.id || activePendingIds.has(entry.id)) return;
    const summary = entry.summary || {};
    const decision = await confirmOrderBeforeSend({
      ...summary,
      pendingId: entry.id,
      title: summary.title || 'Algo Trigger — Confirm Broker Order',
      sourceLabel: 'Auto-Exit / Target Engine requires confirmation + bell alert',
      confirmText: 'Confirm & Send to Broker'
    });

    if (decision === null) return; // Closed remotely from another browser tab

    const endpoint = decision
      ? `/api/pending-orders/${encodeURIComponent(entry.id)}/confirm`
      : `/api/pending-orders/${encodeURIComponent(entry.id)}/reject`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const d = await res.json();
      if (typeof window.showToast === 'function') {
        if (decision) {
          window.showToast(d.success ? `Confirmed & sent: ${summary.symbol || ''}` : (d.message || 'Execution failed'), d.success ? 'success' : 'error');
        } else {
          window.showToast(`Cancelled pending order: ${summary.symbol || ''}`, 'info');
        }
      }
      if (decision && typeof window.loadPositions === 'function') window.loadPositions();
      if (decision && typeof window.loadOrders === 'function') window.loadOrders();
    } catch (e) {}
  }

  function attachOrderConfirmationStream(eventSource) {
    if (eventSource && !eventSource._orderConfirmBound) {
      eventSource._orderConfirmBound = true;
      eventSource.addEventListener('order_confirmation_required', e => {
        try {
          const entry = JSON.parse(e.data);
          handleServerPendingOrder(entry);
        } catch (err) {}
      });
      eventSource.addEventListener('order_confirmation_resolved', e => {
        try {
          const info = JSON.parse(e.data);
          const active = info && info.id ? activePendingIds.get(info.id) : null;
          if (active && typeof active.forceClose === 'function') {
            active.forceClose();
          }
        } catch (err) {}
      });
    }

    fetch('/api/pending-orders')
      .then(r => r.json())
      .then(d => {
        if (d && d.success && Array.isArray(d.data)) {
          d.data.forEach(entry => handleServerPendingOrder(entry));
        }
      })
      .catch(() => {});
  }

  window.playOrderBellSound = playOrderBellSound;
  window.confirmOrderBeforeSend = confirmOrderBeforeSend;
  window.attachOrderConfirmationStream = attachOrderConfirmationStream;
})();
