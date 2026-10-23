/**
 * Meetings page: /meetings (list + new) and /meeting/:id (gate + room).
 *
 * Video is peer-to-peer (a WebRTC mesh): everyone connects to everyone, which
 * suits small meetings (about 6-8 people). The newcomer always makes the offer,
 * so two people never offer to each other at once. Each connection carries one
 * audio and one video transceiver from the start, so turning the camera or
 * screen share on later is a track swap - no renegotiation.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (name) =>
    String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

  const meetingId = (location.pathname.match(/^\/meeting\/([0-9a-f-]{36})/i) || [])[1] || null;

  let me = null;
  let socket = null;
  let iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  let meeting = null;

  // Local media state
  let localStream = new MediaStream();
  let micOn = true;
  let camOn = true;
  let screenTrack = null;
  let myLocked = false; // muted by the host: the mic cannot be turned on
  let myHand = false;
  let pinned = null; // tile id the user clicked to keep big ('self' or a socketId)
  let minutesOn = false;

  // Clear sound: the browser's echo cancelling, noise removal and volume levelling.
  const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  // Clear picture: HD 720p at up to 30 fps.
  const VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };

  // Room state: socketId -> { pc, name, userId, isHost, audio, video, screen, stream, tile }
  const peers = new Map();
  let mySocketId = null;
  let inRoom = false;
  const pendingRequests = new Map(); // userId -> { id, name, role }
  let people = [];

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async function boot() {
    if (!CresAPI.getAccess()) return goLogin();
    try {
      const v = await CresAPI.verify();
      me = v.user || CresAPI.getUser();
    } catch {
      return goLogin();
    }
    try {
      const cfg = await CresAPI.request('/api/meetings/config');
      if (cfg.data?.iceServers?.length) iceServers = cfg.data.iceServers;
    } catch {
      /* defaults */
    }
    connectSocket();
    if (meetingId) await showMeeting();
    else await showList();
  }

  function goLogin() {
    location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
  }

  function connectSocket() {
    if (typeof io === 'undefined') return;
    // auth as a function: every reconnect sends the current (refreshed) token.
    socket = io({
      path: '/socket.io',
      auth: (cb) => cb({ token: CresAPI.getAccess() }),
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });
    // Long meetings outlive the access token: refresh it in the background
    // (CresAPI refreshes on a 401) so a reconnect never fails on an expired token.
    setInterval(() => CresAPI.request('/api/auth/verify').catch(() => {}), 4 * 60 * 1000);
    socket.on('disconnect', () => inRoom && toast('Connection lost. Reconnecting…', [], 4000));
    socket.on('meeting:lock', onLock);
    socket.on('meeting:note', (p) => p.meetingId === meetingId && addNoteRow(p.note));
    socket.on('meeting:transcript', (p) => p.meetingId === meetingId && addTranscriptRow(p.line));
    socket.on('meeting:minutes', (p) => {
      if (p.meetingId !== meetingId) return;
      if (p.enabled !== minutesOn) toast(p.enabled ? `${esc(p.by)} started taking minutes. What you say while unmuted is transcribed.` : 'Minutes stopped.');
      setMinutesState(p.enabled);
    });
    socket.on('meeting:invite', (p) => toast(`${esc(p.from)} invited you to <b>${esc(p.title)}</b>`, [{ label: 'Open', href: `/meeting/${p.meetingId}` }]));
    socket.on('meeting:started', (p) => {
      if (p.meetingId === meetingId && !inRoom) showMeeting();
      else toast(`<b>${esc(p.title)}</b> has started`, [{ label: 'Join', href: `/meeting/${p.meetingId}` }]);
    });
    socket.on('meeting:admission', (p) => {
      if (p.meetingId !== meetingId) return;
      if (p.allowed) {
        toast('The host let you in.');
        showMeeting();
      } else {
        setGate({ msg: 'The host declined your request.', request: true });
      }
    });
    socket.on('meeting:request', onJoinRequest);
    socket.on('meeting:peer-joined', onPeerJoined);
    socket.on('meeting:peer-left', (p) => p.meetingId === meetingId && removePeer(p.socketId));
    socket.on('meeting:signal', onSignal);
    socket.on('meeting:media', onPeerMedia);
    socket.on('meeting:ended', (p) => {
      if (p.meetingId !== meetingId) return;
      leaveRoom(false);
      setView('gate');
      setGate({ title: meeting?.title, sub: 'This meeting has ended.', msg: 'The minutes are being written and will be emailed to everyone.' });
      stopPreview();
      setTimeout(showSummary, 15000);
    });
    socket.on('connect', () => {
      // Reconnected mid-meeting: rejoin the room.
      if (inRoom) rejoin();
    });
  }

  function setView(name) {
    for (const v of ['list', 'gate', 'room']) $(`view-${v}`).hidden = v !== name;
    document.body.classList.toggle('in-room', name === 'room');
  }

  // ---------------------------------------------------------------------------
  // List + new meeting
  // ---------------------------------------------------------------------------

  async function showList() {
    setView('list');
    $('mt-all-link').hidden = true;
    const staff = me?.role !== 'client';
    $('new-meeting-card').hidden = !staff;
    if (staff) await loadPeople().then(renderPicker);
    await renderMeetingList();
  }

  async function loadPeople() {
    try {
      const res = await CresAPI.request('/api/meetings/people');
      people = res.data || [];
    } catch {
      people = [];
    }
  }

  const picked = new Set();
  function renderPicker() {
    const q = ($('nm-search').value || '').toLowerCase();
    const list = people.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.role || '').includes(q)).slice(0, 60);
    $('nm-people').innerHTML = list.length
      ? list
          .map(
            (p) => `<li><label><input type="checkbox" value="${esc(p.id)}" ${picked.has(p.id) ? 'checked' : ''} />
              <span class="mt-av sm">${esc(initials(p.name))}</span><span>${esc(p.name)}</span><span class="mt-role">${esc(p.role)}</span></label></li>`
          )
          .join('')
      : '<li class="mt-muted">No one matches.</li>';
    $('nm-count').textContent = picked.size ? `${picked.size} selected` : 'No one selected';
  }

  async function renderMeetingList() {
    let rows = [];
    try {
      rows = (await CresAPI.request('/api/meetings')).data || [];
    } catch (err) {
      $('meeting-list').innerHTML = `<li class="mt-muted">${esc(err.message)}</li>`;
      return;
    }
    if (!rows.length) {
      $('meeting-list').innerHTML = '<li class="mt-muted">No meetings yet.</li>';
      return;
    }
    $('meeting-list').innerHTML = rows
      .map((m) => {
        const when =
          m.status === 'live'
            ? '<span class="mt-live">● Live</span>'
            : m.status === 'ended'
              ? `Ended ${fmt(m.ended_at)}`
              : m.scheduled_at
                ? fmt(m.scheduled_at)
                : 'Not started';
        const action =
          m.status === 'ended'
            ? ''
            : `<a class="mt-btn ${m.status === 'live' ? 'primary' : ''}" href="/meeting/${m.id}">${
                m.status === 'live' ? 'Join' : m.my_status === 'host' ? 'Start' : 'Open'
              }</a>`;
        return `<li class="mt-row"><div><div class="mt-row-title">${esc(m.title)}</div>
          <div class="mt-muted small">${when} · Host: ${esc(m.host_name)} · ${m.people} people${
            m.my_status === 'pending' ? ' · <i>request pending</i>' : ''
          }</div></div>${action}</li>`;
      })
      .join('');
  }

  function fmt(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function bindList() {
    $('nm-search').addEventListener('input', renderPicker);
    $('nm-people').addEventListener('change', (e) => {
      const cb = e.target.closest('input[type=checkbox]');
      if (!cb) return;
      cb.checked ? picked.add(cb.value) : picked.delete(cb.value);
      $('nm-count').textContent = picked.size ? `${picked.size} selected` : 'No one selected';
    });
    document.querySelectorAll('input[name=nm-when]').forEach((r) =>
      r.addEventListener('change', () => {
        const later = document.querySelector('input[name=nm-when]:checked').value === 'later';
        $('nm-at').disabled = !later;
        $('nm-submit').textContent = later ? 'Schedule & send invites' : 'Start meeting';
      })
    );
    $('new-meeting-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const later = document.querySelector('input[name=nm-when]:checked').value === 'later';
      const at = $('nm-at').value;
      if (later && !at) return alert('Pick a date and time.');
      const btn = $('nm-submit');
      btn.disabled = true;
      try {
        const res = await CresAPI.request('/api/meetings', {
          method: 'POST',
          body: {
            title: $('nm-title').value.trim(),
            start_now: !later,
            scheduled_at: later ? new Date(at).toISOString() : null,
            invitee_ids: [...picked],
          },
        });
        if (later) {
          toast(`Scheduled. Invites sent to ${res.data.invited?.length || 0} people.`);
          picked.clear();
          $('new-meeting-form').reset();
          $('nm-at').disabled = true;
          renderPicker();
          await renderMeetingList();
        } else {
          location.href = `/meeting/${res.data.id}`;
        }
      } catch (err) {
        alert(err.message || 'Could not create the meeting');
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Gate: pre-join preview, request to join, waiting
  // ---------------------------------------------------------------------------

  async function showMeeting() {
    setView('gate');
    try {
      meeting = (await CresAPI.request(`/api/meetings/${meetingId}`)).data;
    } catch (err) {
      setGate({ title: 'Meeting not found', sub: err.message || '', msg: '' });
      return;
    }
    document.title = `${meeting.title} - Meetings`;
    const sub = `Host: ${meeting.host_name}${
      meeting.status === 'scheduled' && meeting.scheduled_at ? ` · ${fmt(meeting.scheduled_at)}` : ''
    }`;
    if (meeting.status === 'ended') {
      setGate({ title: meeting.title, sub: `${sub} · This meeting has ended.` });
      if (meeting.summary) renderSummary(meeting.summary);
      return;
    }

    if (meeting.can_enter) {
      await startPreview();
      if (meeting.status === 'live' || meeting.is_host) {
        return setGate({ title: meeting.title, sub, join: true, joinLabel: meeting.status === 'live' ? 'Join meeting' : 'Start meeting', toggles: true });
      }
      return setGate({ title: meeting.title, sub, msg: 'Waiting for the host to start the meeting…', toggles: true });
    }
    if (meeting.my_status === 'pending') {
      return setGate({ title: meeting.title, sub, msg: 'Waiting for the host to let you in…' });
    }
    if (meeting.my_status === 'denied') {
      return setGate({ title: meeting.title, sub, msg: 'The host declined your request.', request: true });
    }
    return setGate({ title: meeting.title, sub, msg: "You weren't invited to this meeting. Ask the host to let you in.", request: true });
  }

  function setGate({ title, sub, msg = '', join = false, joinLabel = 'Join meeting', request = false, toggles = false }) {
    if (title !== undefined) $('gate-title').textContent = title;
    if (sub !== undefined) $('gate-sub').textContent = sub;
    $('gate-msg').textContent = msg;
    $('gate-join').hidden = !join;
    $('gate-join').textContent = joinLabel;
    $('gate-request').hidden = !request;
    $('gate-toggles').hidden = !toggles;
    $('gate-preview-wrap').hidden = !toggles;
    paintGateToggles();
  }

  async function startPreview() {
    if (localStream.getTracks().length) return attachPreview();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: VIDEO });
      localStream = s;
    } catch {
      // No camera/mic or permission refused: try audio only, then nothing.
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: false });
        camOn = false;
      } catch {
        localStream = new MediaStream();
        micOn = false;
        camOn = false;
        toast('No camera or microphone available. You can still join and watch.');
      }
    }
    applyLocalEnabled();
    attachPreview();
  }

  function attachPreview() {
    $('gate-preview').srcObject = localStream;
    paintGateToggles();
  }

  function stopPreview() {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = new MediaStream();
  }

  function paintGateToggles() {
    $('gate-mic').textContent = micOn ? '🎙 Mic on' : '🔇 Mic off';
    $('gate-cam').textContent = camOn ? '📷 Camera on' : '🚫 Camera off';
    $('gate-mic').classList.toggle('off', !micOn);
    $('gate-cam').classList.toggle('off', !camOn);
    $('gate-preview-off').hidden = camOn && Boolean(localStream.getVideoTracks()[0]);
  }

  function bindGate() {
    $('gate-mic').addEventListener('click', () => toggleMic());
    $('gate-cam').addEventListener('click', () => toggleCam());
    $('gate-join').addEventListener('click', () => joinRoom());
    $('gate-request').addEventListener('click', async () => {
      try {
        const res = await CresAPI.request(`/api/meetings/${meetingId}/request`, { method: 'POST' });
        if (res.data?.status === 'pending') setGate({ msg: 'Request sent. Waiting for the host to let you in…' });
        else showMeeting();
      } catch (err) {
        setGate({ msg: err.message || 'Could not send the request.', request: true });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Room
  // ---------------------------------------------------------------------------

  function joinRoom() {
    if (!socket) return alert('Realtime connection is not available. Refresh and try again.');
    $('gate-join').disabled = true;
    socket.emit('meeting:join', { meetingId, audio: micOn, video: camOn }, (ack) => {
      $('gate-join').disabled = false;
      if (!ack?.ok) {
        const why = { NOT_ADMITTED: "You haven't been let in yet.", ENDED: 'This meeting has ended.', NOT_STARTED: 'The host has not started the meeting yet.' };
        return setGate({ msg: why[ack?.error] || ack?.error || 'Could not join.' });
      }
      mySocketId = ack.socketId;
      inRoom = true;
      meeting.is_host = ack.isHost;
      myLocked = Boolean(ack.locked);
      if (myLocked && micOn) {
        micOn = false;
        applyLocalEnabled();
      }
      document.querySelectorAll('.mt-host-only').forEach((el) => (el.hidden = !ack.isHost));
      $('ctl-hand').hidden = ack.isHost;
      $('room-title').textContent = ack.title || meeting.title;
      $('ctl-end').hidden = !ack.isHost;
      setView('room');
      renderSelfTile();
      audioCtx?.resume?.();
      meters.delete('self');
      watchLevel('self', localStream.getAudioTracks()[0]);
      setMinutesState(Boolean(ack.minutesEnabled));
      loadRecord();
      for (const p of ack.peers) {
        addPeer(p);
        callPeer(p.socketId);
      }
      updateCount();
      paintControls();
      renderLive();
      if (ack.isHost) {
        loadPeople().then(renderSideInvite);
        refreshRoster();
      }
    });
  }

  function rejoin() {
    for (const id of [...peers.keys()]) removePeer(id);
    inRoom = false;
    joinRoom();
  }

  function leaveRoom(notify = true) {
    if (notify && socket) socket.emit('meeting:leave', { meetingId });
    for (const id of [...peers.keys()]) removePeer(id);
    inRoom = false;
    updateTranscriber();
    if (screenTrack) {
      screenTrack.stop();
      screenTrack = null;
    }
  }

  function newPc(socketId) {
    const pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('meeting:signal', { meetingId, to: socketId, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      const peer = peers.get(socketId);
      if (!peer) return;
      if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
      const v = peer.tile?.querySelector('video');
      if (v && v.srcObject !== peer.stream) v.srcObject = peer.stream;
      if (e.track.kind === 'audio') watchLevel(socketId, e.track);
      paintTile(socketId);
    };
    pc.onconnectionstatechange = () => {
      const peer = peers.get(socketId);
      if (!peer || peer.pc !== pc) return;
      const state = pc.connectionState;
      if (peer.tile) peer.tile.classList.toggle('weak', ['failed', 'disconnected'].includes(state));
      clearTimeout(peer.restartTimer);
      if (state === 'failed') restartIce(socketId);
      // 'disconnected' often heals by itself; give it a few seconds first.
      if (state === 'disconnected') peer.restartTimer = setTimeout(() => {
        if (peer.pc === pc && pc.connectionState !== 'connected') restartIce(socketId);
      }, 4000);
      if (state === 'connected') {
        peer.restarts = 0;
        applyBitrate();
      }
    };
    return pc;
  }

  /** The track this person is sending as video right now: screen beats camera. */
  function outgoingVideo() {
    if (screenTrack) return screenTrack;
    return camOn ? localStream.getVideoTracks()[0] || null : null;
  }

  function outgoingAudio() {
    return localStream.getAudioTracks()[0] || null;
  }

  async function syncSenders(pc) {
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver.track?.kind;
      if (!kind) continue;
      t.direction = 'sendrecv';
      await t.sender.replaceTrack(kind === 'audio' ? outgoingAudio() : outgoingVideo()).catch(() => {});
    }
  }

  /** Newcomer side: offer to someone already in the room. */
  async function callPeer(socketId) {
    const peer = peers.get(socketId);
    const pc = newPc(socketId);
    peer.pc = pc;
    peer.initiator = true;
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    pc.addTransceiver('video', { direction: 'sendrecv' });
    await syncSenders(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // fresh: a brand-new connection, so the other side must drop any old one.
    socket.emit('meeting:signal', { meetingId, to: socketId, data: { sdp: pc.localDescription, fresh: true } });
  }

  async function onSignal({ meetingId: mid, from, data }) {
    if (mid !== meetingId || !inRoom) return;
    let peer = peers.get(from);
    if (!peer) return;
    if (data.restartRequest) {
      if (peer.initiator) restartIce(from, true);
      return;
    }
    if (data.sdp?.type === 'offer') {
      // First offer builds the connection; later ones (ICE restarts) reuse it.
      if (!peer.pc || peer.pc.connectionState === 'closed' || data.fresh) {
        peer.pc?.close();
        peer.pc = newPc(from);
        peer.initiator = false;
        peer.queued = [];
      }
      await peer.pc.setRemoteDescription(data.sdp);
      await syncSenders(peer.pc);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('meeting:signal', { meetingId, to: from, data: { sdp: peer.pc.localDescription } });
      flushCandidates(peer);
    } else if (data.sdp?.type === 'answer') {
      await peer.pc?.setRemoteDescription(data.sdp);
      flushCandidates(peer);
    } else if (data.candidate) {
      if (peer.pc?.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else (peer.queued ||= []).push(data.candidate);
    }
  }

  function flushCandidates(peer) {
    for (const c of peer.queued || []) peer.pc.addIceCandidate(c).catch(() => {});
    peer.queued = [];
  }

  /**
   * Find a new network path to one person without dropping the call. Only the
   * side that made the first offer restarts; the other side asks it to.
   * After repeated failures the connection is rebuilt from scratch.
   */
  async function restartIce(socketId, requested = false) {
    const peer = peers.get(socketId);
    if (!peer?.pc || !inRoom) return;
    if (!peer.initiator) {
      if (!requested) socket.emit('meeting:signal', { meetingId, to: socketId, data: { restartRequest: true } });
      return;
    }
    peer.restarts = (peer.restarts || 0) + 1;
    try {
      if (peer.restarts > 3) {
        peer.pc.close();
        peer.restarts = 0;
        return callPeer(socketId);
      }
      const offer = await peer.pc.createOffer({ iceRestart: true });
      await peer.pc.setLocalDescription(offer);
      socket.emit('meeting:signal', { meetingId, to: socketId, data: { sdp: peer.pc.localDescription } });
    } catch {
      /* next state change will retry */
    }
  }

  /**
   * Keep the total upload sane: each extra person means another copy of our
   * video, so lower the per-connection bitrate and resolution as the room grows.
   */
  async function applyBitrate() {
    const n = peers.size;
    const sharing = Boolean(screenTrack);
    const maxBitrate = sharing ? 3_000_000 : n <= 1 ? 2_500_000 : n <= 3 ? 1_500_000 : n <= 5 ? 1_000_000 : 700_000;
    const scale = sharing ? 1 : n <= 3 ? 1 : n <= 5 ? 1.25 : 1.5;
    for (const peer of peers.values()) {
      const sender = peer.pc?.getSenders().find((x) => x.track?.kind === 'video');
      if (!sender) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = maxBitrate;
        params.encodings[0].scaleResolutionDownBy = scale;
        params.degradationPreference = sharing ? 'maintain-resolution' : 'balanced';
        await sender.setParameters(params);
      } catch {
        /* not negotiated yet; applied again on connect */
      }
    }
  }

  function onPeerJoined(p) {
    if (p.meetingId !== meetingId || !inRoom || p.socketId === mySocketId) return;
    addPeer(p); // they will send the offer
    updateCount();
    if (meeting?.is_host) refreshRoster();
  }

  function addPeer(p) {
    if (peers.has(p.socketId)) return;
    const peer = { ...p, stream: new MediaStream(), pc: null, tile: null };
    peers.set(p.socketId, peer);
    peer.tile = makeTile(p.socketId, p.name, false);
    $('room-grid').appendChild(peer.tile);
    peer.tile.querySelector('video').srcObject = peer.stream;
    paintTile(p.socketId);
    layoutGrid();
    applyBitrate();
    renderLive();
  }

  function removePeer(socketId) {
    const peer = peers.get(socketId);
    if (!peer) return;
    peer.pc?.close();
    peer.tile?.remove();
    meters.delete(socketId);
    if (pinned === socketId) pinned = null;
    clearTimeout(peer.restartTimer);
    peers.delete(socketId);
    updateCount();
    layoutGrid();
    applyBitrate();
    renderLive();
    if (meeting?.is_host) refreshRoster();
  }

  function onPeerMedia(p) {
    if (p.meetingId !== meetingId) return;
    const peer = peers.get(p.socketId);
    if (!peer) return;
    const handUp = p.hand && !peer.hand;
    const screenChanged = Boolean(p.screen) !== Boolean(peer.screen);
    Object.assign(peer, { audio: p.audio, video: p.video, screen: p.screen, locked: Boolean(p.locked), hand: Boolean(p.hand) });
    paintTile(p.socketId);
    if (screenChanged) layoutGrid();
    renderLive();
    if (handUp && meeting?.is_host) {
      toast(`✋ ${esc(peer.name)} raised their hand`, [{ label: 'Allow to speak', onClick: () => hostMute(p.socketId, false) }], 15000);
    }
  }

  // ----- Tiles -----

  function makeTile(id, name, self) {
    const el = document.createElement('div');
    el.className = `mt-tile${self ? ' self' : ''}`;
    el.dataset.id = id;
    el.innerHTML = `<video autoplay playsinline ${self ? 'muted' : ''}></video>
      <div class="mt-tile-off"><span class="mt-av">${esc(initials(name))}</span></div>
      ${self ? '<div class="mt-presenting">🖥 You are presenting your screen</div>' : ''}
      <div class="mt-level" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      <button type="button" class="mt-pin" title="Pin">📌</button>
      <div class="mt-tile-name"><span class="mt-hand" hidden>✋</span><span class="mt-lock" hidden title="Muted by host">🔒</span><span class="mt-mic-off" hidden>🔇</span> ${esc(name)}${self ? ' (you)' : ''}</div>`;
    return el;
  }

  function renderSelfTile() {
    let tile = document.querySelector('.mt-tile.self');
    if (!tile) {
      tile = makeTile('self', me?.name || 'You', true);
      $('room-grid').prepend(tile);
    }
    const v = tile.querySelector('video');
    // While presenting, show your camera (or a note), never your own screen:
    // watching your own share inside the shared screen is what repeats endlessly.
    const track = camOn ? localStream.getVideoTracks()[0] || null : null;
    v.srcObject = track ? new MediaStream([track]) : null;
    tile.classList.toggle('cam-off', !track);
    tile.classList.toggle('presenting', Boolean(screenTrack));
    tile.querySelector('.mt-mic-off').hidden = micOn;
    tile.querySelector('.mt-lock').hidden = !myLocked;
    tile.querySelector('.mt-hand').hidden = !myHand;
    layoutGrid();
  }

  function paintTile(socketId) {
    const peer = peers.get(socketId);
    if (!peer?.tile) return;
    const hasVideo = peer.video !== false || peer.screen;
    const liveTrack = peer.stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
    peer.tile.classList.toggle('cam-off', !hasVideo || !liveTrack);
    peer.tile.classList.toggle('screen', Boolean(peer.screen));
    peer.tile.querySelector('.mt-mic-off').hidden = peer.audio !== false;
    peer.tile.querySelector('.mt-lock').hidden = !peer.locked;
    peer.tile.querySelector('.mt-hand').hidden = !peer.hand;
    // Enforcement on the receiving side: someone the host muted is silent here
    // even if their own browser kept sending sound.
    peer.tile.querySelector('video').muted = Boolean(peer.locked);
    peer.stream.getVideoTracks().forEach((t) => {
      t.onunmute = () => paintTile(socketId);
      t.onmute = () => paintTile(socketId);
    });
  }

  /**
   * Who is "the big one": a pinned tile, else whoever is sharing a screen.
   * Everyone else goes to a strip down the side, like Zoom's speaker view.
   */
  function layoutGrid() {
    const grid = $('room-grid');
    const n = grid.children.length;
    let spot = pinned && grid.querySelector(`.mt-tile[data-id="${CSS.escape(pinned)}"]`);
    if (!spot) {
      const sharer = [...peers.entries()].find(([, p]) => p.screen);
      spot = sharer ? sharer[1].tile : null;
    }
    grid.querySelectorAll('.mt-tile').forEach((t) => t.classList.toggle('spot', t === spot));
    grid.querySelectorAll('.mt-tile').forEach((t) => t.classList.toggle('pinned', t.dataset.id === pinned));
    grid.classList.toggle('has-spot', Boolean(spot) && n > 1);
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    grid.style.setProperty('--cols', cols);
  }

  // ----- Voice level bars + "who is speaking" -----

  let audioCtx = null;
  const meters = new Map(); // tile id -> { analyser, data }

  function watchLevel(id, track) {
    if (!track || typeof AudioContext === 'undefined') return;
    try {
      audioCtx ||= new AudioContext();
      const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser); // measured only, never played twice
      meters.set(id, { analyser, data: new Uint8Array(analyser.fftSize) });
    } catch {
      /* no meter on this browser */
    }
  }

  function levelLoop() {
    for (const [id, m] of meters) {
      m.analyser.getByteTimeDomainData(m.data);
      let sum = 0;
      for (const v of m.data) sum += (v - 128) * (v - 128);
      const rms = Math.sqrt(sum / m.data.length) / 128;
      const peer = id === 'self' ? null : peers.get(id);
      const silent = id === 'self' ? !micOn : peer?.locked || peer?.audio === false;
      const level = silent ? 0 : Math.min(1, rms * 5);
      const tile = id === 'self' ? document.querySelector('.mt-tile.self') : peer?.tile;
      if (tile) {
        tile.style.setProperty('--lvl', level.toFixed(2));
        tile.classList.toggle('speaking', level > 0.12);
      }
      if (id === 'self') $('ctl-mic').style.setProperty('--lvl', level.toFixed(2));
    }
    requestAnimationFrame(levelLoop);
  }
  requestAnimationFrame(levelLoop);

  function updateCount() {
    const n = peers.size + 1;
    $('room-count').textContent = `${n} ${n === 1 ? 'person' : 'people'}`;
  }

  // ----- Controls: mic, camera (really off, light goes out), screen share -----

  function applyLocalEnabled() {
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  }

  function toggleMic() {
    if (!localStream.getAudioTracks().length) return toast('No microphone available.');
    if (myLocked && !micOn) {
      return toast('The host has muted you. Raise your hand to ask to speak.', [{ label: '✋ Raise hand', onClick: () => setHand(true) }]);
    }
    micOn = !micOn;
    applyLocalEnabled();
    paintGateToggles();
    afterMediaChange();
  }

  async function toggleCam() {
    if (camOn) {
      // Stop the camera completely so its light goes off, like Zoom.
      localStream.getVideoTracks().forEach((t) => {
        t.stop();
        localStream.removeTrack(t);
      });
      camOn = false;
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: VIDEO });
        const track = s.getVideoTracks()[0];
        localStream.addTrack(track);
        camOn = true;
      } catch {
        return toast('Could not turn on the camera. Check the browser permission.');
      }
    }
    if (!inRoom) attachPreview();
    await afterMediaChange();
  }

  async function toggleScreen() {
    if (screenTrack) {
      screenTrack.stop();
      screenTrack = null;
    } else {
      try {
        // selfBrowserSurface 'exclude' keeps this meeting tab out of the picker,
        // which (with the self tile below) stops the endless mirror effect.
        const s = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 30 } },
          audio: false,
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
        });
        screenTrack = s.getVideoTracks()[0];
        screenTrack.contentHint = 'detail'; // keep text sharp rather than smooth motion
        screenTrack.onended = () => {
          screenTrack = null;
          afterMediaChange();
        };
      } catch {
        return;
      }
    }
    await afterMediaChange();
  }

  async function afterMediaChange() {
    paintGateToggles();
    if (!inRoom) return;
    updateTranscriber();
    for (const peer of peers.values()) if (peer.pc) await syncSenders(peer.pc);
    applyBitrate();
    renderSelfTile();
    paintControls();
    socket.emit('meeting:media', { meetingId, audio: micOn, video: camOn, screen: Boolean(screenTrack) });
  }

  function paintControls() {
    $('ctl-mic').classList.toggle('off', !micOn);
    $('ctl-mic').classList.toggle('locked', myLocked);
    $('ctl-mic').querySelector('span').textContent = myLocked ? 'Muted by host' : micOn ? 'Mute' : 'Unmute';
    $('ctl-hand').classList.toggle('on', myHand);
    $('ctl-hand').querySelector('span').textContent = myHand ? 'Lower hand' : 'Raise hand';
    $('ctl-cam').classList.toggle('off', !camOn);
    $('ctl-cam').querySelector('span').textContent = camOn ? 'Stop video' : 'Start video';
    $('ctl-screen').classList.toggle('on', Boolean(screenTrack));
    $('ctl-screen').querySelector('span').textContent = screenTrack ? 'Stop share' : 'Share';
  }

  // ----- Host: join requests, roster, invite more -----

  function onJoinRequest(p) {
    if (p.meetingId !== meetingId || !meeting?.is_host) {
      if (p.meetingId !== meetingId) toast(`${esc(p.user.name)} asked to join <b>${esc(p.title)}</b>`, [{ label: 'Open', href: `/meeting/${p.meetingId}` }]);
      return;
    }
    pendingRequests.set(p.user.id, p.user);
    renderRequests();
    toast(`${esc(p.user.name)} wants to join`, [
      { label: 'Admit', onClick: () => admit(p.user.id, true) },
      { label: 'Deny', onClick: () => admit(p.user.id, false) },
    ], 20000);
  }

  async function admit(userId, allow) {
    try {
      await CresAPI.request(`/api/meetings/${meetingId}/admit`, { method: 'POST', body: { user_id: userId, allow } });
      pendingRequests.delete(userId);
      renderRequests();
      refreshRoster();
    } catch (err) {
      toast(esc(err.message || 'Could not answer the request'));
    }
  }

  function renderRequests() {
    const n = pendingRequests.size;
    $('ctl-badge').hidden = !n;
    $('ctl-badge').textContent = String(n);
    $('side-requests').innerHTML = n
      ? `<div class="mt-side-sec"><div class="mt-side-label">Waiting to join</div>${[...pendingRequests.values()]
          .map(
            (u) => `<div class="mt-req"><span>${esc(u.name)}</span>
              <button type="button" class="mt-btn sm primary" data-admit="${esc(u.id)}">Admit</button>
              <button type="button" class="mt-btn sm" data-deny="${esc(u.id)}">Deny</button></div>`
          )
          .join('')}</div>`
      : '';
  }

  async function refreshRoster() {
    if (!meeting?.is_host) return;
    try {
      const data = (await CresAPI.request(`/api/meetings/${meetingId}`)).data;
      const inCall = new Set([me.id, ...[...peers.values()].map((p) => p.userId)]);
      for (const p of data.participants || []) if (p.status === 'pending') pendingRequests.set(p.user_id, { id: p.user_id, name: p.name, role: p.role });
      renderRequests();
      $('side-roster').innerHTML = (data.participants || [])
        .filter((p) => p.status !== 'pending' && p.status !== 'denied')
        .map((p) => `<li><span class="mt-av sm">${esc(initials(p.name))}</span><span>${esc(p.name)}</span>
          <span class="mt-role">${p.status === 'host' ? 'host' : inCall.has(p.user_id) ? 'in meeting' : 'invited'}</span></li>`)
        .join('');
    } catch {
      /* ignore */
    }
  }

  function renderSideInvite() {
    $('side-invite-wrap').hidden = false;
    const q = ($('side-search').value || '').toLowerCase();
    const list = q ? people.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8) : [];
    $('side-people').innerHTML = list
      .map((p) => `<li><span>${esc(p.name)}</span><button type="button" class="mt-btn sm" data-invite="${esc(p.id)}">Invite</button></li>`)
      .join('');
  }

  function bindRoom() {
    $('ctl-mic').addEventListener('click', () => toggleMic());
    $('ctl-cam').addEventListener('click', () => toggleCam());
    $('ctl-screen').addEventListener('click', () => toggleScreen());
    $('ctl-people').addEventListener('click', () => {
      $('room-side').hidden = !$('room-side').hidden;
      $('notes-side').hidden = true;
      if (!$('room-side').hidden) {
        renderLive();
        refreshRoster();
      }
    });
    $('side-close').addEventListener('click', () => ($('room-side').hidden = true));
    $('ctl-leave').addEventListener('click', () => {
      leaveRoom(true);
      stopPreview();
      location.href = '/meetings';
    });
    $('ctl-end').addEventListener('click', async () => {
      if (!confirm('End this meeting for everyone?')) return;
      try {
        await CresAPI.request(`/api/meetings/${meetingId}/end`, { method: 'POST' });
      } catch (err) {
        alert(err.message);
      }
    });
    $('side-requests').addEventListener('click', (e) => {
      const a = e.target.closest('[data-admit]');
      const d = e.target.closest('[data-deny]');
      if (a) admit(a.dataset.admit, true);
      if (d) admit(d.dataset.deny, false);
    });
    $('side-search').addEventListener('input', renderSideInvite);
    $('ctl-hand').addEventListener('click', () => setHand(!myHand));
    $('ctl-notes').addEventListener('click', () => {
      $('notes-side').hidden = !$('notes-side').hidden;
      $('room-side').hidden = true;
      $('ctl-notes').classList.remove('ping');
      if (!$('notes-side').hidden) $('note-input').focus();
    });
    $('notes-close').addEventListener('click', () => ($('notes-side').hidden = true));
    $('minutes-toggle').addEventListener('change', (e) => socket.emit('meeting:minutes', { meetingId, enabled: e.target.checked }));
    $('note-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const content = $('note-input').value.trim();
      if (!content) return;
      socket.emit('meeting:note', { meetingId, content }, (ack) => {
        if (ack?.ok) $('note-input').value = '';
        else toast('Could not add the note.');
      });
    });
    $('note-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('note-form').requestSubmit();
      }
    });
    // Click a tile's pin to keep it big; click again to let screen shares lead.
    $('room-grid').addEventListener('click', (e) => {
      const btn = e.target.closest('.mt-pin');
      if (!btn) return;
      const id = btn.closest('.mt-tile')?.dataset.id;
      pinned = pinned === id ? null : id;
      layoutGrid();
    });
    $('mute-all').addEventListener('click', () => hostMute('all', true));
    $('allow-all').addEventListener('click', () => hostMute('all', false));
    $('side-live').addEventListener('click', (e) => {
      const lock = e.target.closest('[data-lock]');
      const unlock = e.target.closest('[data-unlock]');
      if (lock) hostMute(lock.dataset.lock, true);
      if (unlock) hostMute(unlock.dataset.unlock, false);
    });
    $('side-people').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-invite]');
      if (!b) return;
      b.disabled = true;
      try {
        await CresAPI.request(`/api/meetings/${meetingId}/invite`, { method: 'POST', body: { user_ids: [b.dataset.invite] } });
        b.textContent = 'Invited ✓';
        refreshRoster();
      } catch (err) {
        b.disabled = false;
        toast(esc(err.message));
      }
    });
    window.addEventListener('beforeunload', () => {
      if (inRoom) socket?.emit('meeting:leave', { meetingId });
    });
  }

  // ----- Host mute lock, raise hand -----

  function onLock(p) {
    if (p.meetingId !== meetingId) return;
    const was = myLocked;
    myLocked = Boolean(p.locked);
    myHand = false;
    if (myLocked && micOn) {
      micOn = false;
      applyLocalEnabled();
      afterMediaChange();
    }
    if (myLocked && !was) toast(`${esc(p.by || 'The host')} muted you. You can't unmute until the host allows it.`);
    if (!myLocked && was) toast('The host allowed you to speak. Unmute when you are ready.', [{ label: 'Unmute', onClick: () => toggleMic() }]);
    renderSelfTile();
    paintControls();
    renderLive();
    updateTranscriber();
  }

  function setHand(up) {
    myHand = Boolean(up);
    socket.emit('meeting:hand', { meetingId, up: myHand });
    renderSelfTile();
    paintControls();
  }

  /** Host: lock (mute) or release one person, or 'all'. */
  function hostMute(target, locked) {
    if (!meeting?.is_host) return;
    socket.emit('meeting:host-mute', { meetingId, target, locked });
  }

  /** "In this meeting" list; the host gets a mute / allow button per person. */
  function renderLive() {
    const list = $('side-live');
    if (!list) return;
    const rows = [`<li><span class="mt-av sm">${esc(initials(me?.name))}</span><span>${esc(me?.name || 'You')} (you)</span>
      <span class="mt-role">${meeting?.is_host ? 'host' : myLocked ? '🔒 muted by host' : micOn ? '🎙' : '🔇'}</span></li>`];
    for (const [sid, p] of peers) {
      const state = p.locked ? '🔒' : p.audio === false ? '🔇' : '🎙';
      const btn = meeting?.is_host && !p.isHost
        ? p.locked
          ? `<button type="button" class="mt-btn sm primary" data-unlock="${esc(sid)}">Allow to speak</button>`
          : `<button type="button" class="mt-btn sm" data-lock="${esc(sid)}">Mute</button>`
        : p.isHost ? '<span class="mt-role">host</span>' : '';
      rows.push(`<li><span class="mt-av sm">${esc(initials(p.name))}</span><span>${p.hand ? '✋ ' : ''}${esc(p.name)}</span>
        <span class="mt-role">${state}</span>${btn}</li>`);
    }
    list.innerHTML = rows.join('');
  }

  // ----- Notes & live minutes -----

  const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  async function loadRecord() {
    try {
      const data = (await CresAPI.request(`/api/meetings/${meetingId}/record`)).data;
      $('notes-list').innerHTML = '';
      $('transcript-list').innerHTML = '';
      (data.notes || []).forEach(addNoteRow);
      (data.transcript || []).forEach(addTranscriptRow);
      if (!data.notes?.length) $('notes-list').innerHTML = '<li class="mt-muted small">No notes yet.</li>';
      if (!data.transcript?.length) $('transcript-list').innerHTML = `<li class="mt-muted small">${minutesOn ? 'Listening…' : 'Not recording.'}</li>`;
    } catch {
      /* notes stay empty */
    }
  }

  function addNoteRow(n) {
    if (!n) return;
    const list = $('notes-list');
    list.querySelector('.mt-muted')?.remove();
    if (list.querySelector(`[data-id="${CSS.escape(n.id)}"]`)) return;
    list.insertAdjacentHTML('beforeend', `<li data-id="${esc(n.id)}"><b>${esc(n.author_name)}</b> <span class="mt-muted small">${hhmm(n.created_at)}</span><div>${esc(n.content)}</div></li>`);
    list.scrollTop = list.scrollHeight;
    if ($('notes-side').hidden && n.user_id !== me?.id) $('ctl-notes').classList.add('ping');
  }

  function addTranscriptRow(t) {
    if (!t) return;
    const list = $('transcript-list');
    list.querySelector('.mt-muted')?.remove();
    if (list.querySelector(`[data-id="${CSS.escape(t.id)}"]`)) return;
    list.insertAdjacentHTML('beforeend', `<li data-id="${esc(t.id)}"><b>${esc(t.speaker_name)}</b> <span class="mt-muted small">${hhmm(t.spoken_at)}</span> ${esc(t.text)}</li>`);
    list.scrollTop = list.scrollHeight;
  }

  function setMinutesState(on) {
    minutesOn = Boolean(on);
    $('room-minutes').hidden = !minutesOn;
    $('minutes-note').hidden = !minutesOn;
    $('minutes-toggle').checked = minutesOn;
    const empty = $('transcript-list').querySelector('.mt-muted');
    if (empty) empty.textContent = minutesOn ? 'Listening…' : 'Not recording.';
    updateTranscriber();
  }

  /**
   * Live minutes: each person's own browser turns their own speech into text
   * (Chrome / Edge), only while minutes are on and their mic is on and unlocked.
   */
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  let recognizing = false;
  let warnedNoSpeech = false;

  function updateTranscriber() {
    const want = inRoom && minutesOn && micOn && !myLocked;
    if (!Recognition) {
      if (want && !warnedNoSpeech) {
        warnedNoSpeech = true;
        toast("This browser can't transcribe speech for the minutes. Use Chrome or Edge, or add notes instead.");
      }
      return;
    }
    if (want && !recognizing) {
      recognizer ||= makeRecognizer();
      try {
        recognizer.start();
        recognizing = true;
      } catch {
        /* already starting */
      }
    } else if (!want && recognizing) {
      recognizing = false;
      try {
        recognizer.stop();
      } catch {
        /* already stopped */
      }
    }
  }

  function makeRecognizer() {
    const r = new Recognition();
    r.continuous = true;
    r.interimResults = false;
    r.lang = navigator.language || 'en-US';
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res.isFinal && res[0]?.transcript?.trim();
        if (text) socket.emit('meeting:transcript', { meetingId, text });
      }
    };
    r.onend = () => {
      // Chrome stops listening after a pause; keep going while minutes are on.
      if (recognizing) setTimeout(() => {
        try {
          if (recognizing) r.start();
        } catch {
          /* ignore */
        }
      }, 250);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        recognizing = false;
        toast('Speech transcription was blocked by the browser. Your notes still go into the minutes.');
      }
    };
    return r;
  }

  async function showSummary() {
    try {
      const data = (await CresAPI.request(`/api/meetings/${meetingId}`)).data;
      if (data.summary) renderSummary(data.summary);
    } catch {
      /* not ready */
    }
  }

  function renderSummary(text) {
    const html = String(text)
      .split('\n')
      .map((raw) => {
        const line = esc(raw).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
        if (/^#{1,3}\s+/.test(line)) return `<h4>${line.replace(/^#{1,3}\s+/, '')}</h4>`;
        if (/^\s*[-•]\s+/.test(line)) return `<div class="mt-li">• ${line.replace(/^\s*[-•]\s+/, '')}</div>`;
        return line.trim() ? `<p>${line}</p>` : '';
      })
      .join('');
    $('gate-summary').innerHTML = `<div class="mt-side-label">Minutes</div>${html}`;
    $('gate-summary').hidden = false;
    $('gate-msg').textContent = 'The minutes were emailed to everyone in the meeting.';
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------

  function toast(html, actions = [], ms = 6000) {
    const el = document.createElement('div');
    el.className = 'mt-toast';
    el.innerHTML = `<div>${html}</div>`;
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'mt-toast-actions';
      for (const a of actions) {
        const b = document.createElement(a.href ? 'a' : 'button');
        b.className = 'mt-btn sm';
        b.textContent = a.label;
        if (a.href) b.href = a.href;
        else b.addEventListener('click', () => {
          a.onClick();
          el.remove();
        });
        row.appendChild(b);
      }
      el.appendChild(row);
    }
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  bindList();
  bindGate();
  bindRoom();
  boot();
})();
