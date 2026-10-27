/**
 * 语音舞台 Canvas 2D 场景：背景尘埃、声波粒子带、扩散光圈、地面涟漪与爆发粒子。
 * 两层画布分别位于 SVG 舞台的后方和前方，用来制造纵深。
 */

export type StageMode = 'idle' | 'listening' | 'answering' | 'busy'

export interface StageLayout {
  width: number
  height: number
  centerX: number
  centerY: number
  orbRadius: number
  groundY: number
}

export interface VoiceStageScene {
  resize(layout: StageLayout): void
  setMode(mode: StageMode): void
  setAnalyser(analyser: AnalyserNode | null): void
  /** 交互触发的一次性爆发 */
  pulse(): void
  destroy(): void
}

interface Dust {
  x: number
  y: number
  depth: number
  size: number
  phase: number
  speed: number
  tint: number
}

interface Ring {
  radius: number
  alpha: number
  speed: number
  start: number
  span: number
}

interface Ripple {
  rx: number
  alpha: number
  speed: number
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  tint: number
}

const TAU = Math.PI * 2

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const rand = (min: number, max: number) => min + Math.random() * (max - min)

function createGlowSprite(inner: string, outer: string, size = 64) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, inner)
  gradient.addColorStop(0.32, outer)
  gradient.addColorStop(1, outer.replace(/[\d.]+\)$/u, '0)'))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  return canvas
}

function createBeamSprite() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const horizontal = ctx.createLinearGradient(8, 0, 56, 0)
  horizontal.addColorStop(0, 'rgba(88, 240, 255, 0)')
  horizontal.addColorStop(0.5, 'rgba(170, 253, 255, 0.9)')
  horizontal.addColorStop(1, 'rgba(88, 240, 255, 0)')
  ctx.fillStyle = horizontal
  ctx.beginPath()
  ctx.moveTo(32, 0)
  ctx.lineTo(56, 256)
  ctx.lineTo(8, 256)
  ctx.closePath()
  ctx.fill()
  const vertical = ctx.createLinearGradient(0, 0, 0, 256)
  vertical.addColorStop(0, 'rgba(88, 240, 255, 0)')
  vertical.addColorStop(0.5, 'rgba(88, 240, 255, 0.28)')
  vertical.addColorStop(0.86, 'rgba(160, 252, 255, 0.72)')
  vertical.addColorStop(1, 'rgba(220, 255, 255, 0.98)')
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = vertical
  ctx.fillRect(0, 0, 64, 256)
  return canvas
}

const BEAMS = [
  { at: 0.06, width: 0.02, height: 0.3, phase: 0.4 },
  { at: 0.16, width: 0.014, height: 0.2, phase: 2.1 },
  { at: 0.27, width: 0.026, height: 0.26, phase: 4.2 },
  { at: 0.4, width: 0.012, height: 0.16, phase: 1.2 },
  { at: 0.58, width: 0.02, height: 0.22, phase: 3.6 },
  { at: 0.7, width: 0.03, height: 0.32, phase: 5.1 },
  { at: 0.84, width: 0.015, height: 0.18, phase: 0.9 },
  { at: 0.94, width: 0.024, height: 0.28, phase: 2.8 },
]

export function createVoiceStageScene(
  backCanvas: HTMLCanvasElement,
  frontCanvas: HTMLCanvasElement,
  onLevel: (level: number, orbScale: number) => void,
): VoiceStageScene {
  const backContext = backCanvas.getContext('2d')
  const frontContext = frontCanvas.getContext('2d')
  if (!backContext || !frontContext) throw new Error('浏览器不支持 Canvas 2D')
  const back: CanvasRenderingContext2D = backContext
  const front: CanvasRenderingContext2D = frontContext

  const brightSprite = createGlowSprite('rgba(236, 255, 255, 0.95)', 'rgba(120, 246, 255, 0.55)')
  const cyanSprite = createGlowSprite('rgba(160, 250, 255, 0.85)', 'rgba(38, 205, 231, 0.42)')
  const beamSprite = createBeamSprite()

  let layout: StageLayout = { width: 1, height: 1, centerX: 0, centerY: 0, orbRadius: 100, groundY: 0 }
  let dpr = 1
  let haloGradient: CanvasGradient | null = null
  let groundGradient: CanvasGradient | null = null

  let mode: StageMode = 'idle'
  let time = 0
  let wavePhase = 0
  let accentCooldown = 0
  let previousLevel = 0
  let last = performance.now()
  let raf = 0
  let level = 0
  let activity = 0.05
  let flash = 0
  let ringTimer = 1.2
  let rippleTimer = 0.8
  let sparkBudget = 0
  let breathPhase = 0
  let breathEnergy = 0
  let breathAmp = 0.032
  let breathRate = 0.74
  let reducedMotion = false
  try {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    reducedMotion = false
  }

  let analyser: AnalyserNode | null = null
  let waveData: Uint8Array<ArrayBuffer> | null = null

  const dust: Dust[] = Array.from({ length: 120 }, () => ({
    x: Math.random(),
    y: Math.random(),
    depth: rand(0.25, 1),
    size: rand(0.5, 2.2),
    phase: rand(0, TAU),
    speed: rand(0.008, 0.035),
    tint: Math.random(),
  }))

  const frontDust: Dust[] = Array.from({ length: 22 }, () => ({
    x: Math.random(),
    y: Math.random(),
    depth: rand(0.4, 1),
    size: rand(1, 2.8),
    phase: rand(0, TAU),
    speed: rand(0.004, 0.018),
    tint: Math.random(),
  }))

  let rings: Ring[] = []
  let ripples: Ripple[] = []
  let sparks: Particle[] = []
  let bursts: Particle[] = []

  function spawnBurst(strength = 1) {
    const { centerX, centerY, orbRadius } = layout
    const count = Math.round(22 + 42 * strength)
    for (let i = 0; i < count; i += 1) {
      const angle = rand(0, TAU)
      const speed = rand(60, 300) * (0.7 + strength * 0.6)
      const life = rand(0.55, 1.5)
      bursts.push({
        x: centerX + Math.cos(angle) * orbRadius * rand(0.92, 1.06),
        y: centerY + Math.sin(angle) * orbRadius * rand(0.92, 1.06),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.75,
        life,
        maxLife: life,
        size: rand(0.8, 2.8),
        tint: Math.random(),
      })
    }
    flash = 1
  }

  function spawnSpark() {
    const { centerX, centerY, orbRadius } = layout
    const angle = rand(0, TAU)
    const life = rand(1.1, 2.6)
    sparks.push({
      x: centerX + Math.cos(angle) * orbRadius * rand(1.05, 1.7),
      y: centerY + Math.sin(angle) * orbRadius * rand(1.05, 1.7),
      vx: Math.cos(angle) * rand(18, 64),
      vy: Math.sin(angle) * rand(14, 46) - rand(4, 18),
      life,
      maxLife: life,
      size: rand(0.6, 1.9),
      tint: Math.random(),
    })
    if (sparks.length > 190) sparks = sparks.slice(sparks.length - 190)
  }

  function readLevel(dt: number) {
    let target: number
    if (mode === 'answering') {
      const envelope =
        0.5 + Math.sin(time * 7.1) * 0.28 + Math.sin(time * 3.2 + 1.1) * 0.16 + Math.sin(time * 13.7) * 0.06
      target = clamp01(envelope)
    } else if (mode === 'listening') {
      target = 0
      if (analyser && waveData) {
        analyser.getByteTimeDomainData(waveData)
        let sum = 0
        let count = 0
        for (let i = 0; i < waveData.length; i += 4) {
          const sample = ((waveData[i] ?? 128) - 128) / 128
          sum += sample * sample
          count += 1
        }
        target = clamp01((Math.sqrt(sum / Math.max(1, count)) - 0.012) * 9)
      }
    } else if (mode === 'busy') {
      target = 0.16 + Math.sin(time * 2.2) * 0.06
    } else {
      target = 0.035 + Math.sin(time * 1.4) * 0.015
    }
    const rate = target > level ? 14 : 3.6
    level += (target - level) * (1 - Math.exp(-dt * rate))

    const targetActivity =
      mode === 'listening'
        ? 0.3 + level * 0.65
        : mode === 'answering'
          ? 0.62 + level * 0.3
          : mode === 'busy'
            ? 0.24
            : 0.06
    activity += (targetActivity - activity) * (1 - Math.exp(-dt * 2.4))
  }

  // 静默约 8.5 秒一轮；说话时随平滑音量加大幅度并略提速度，避免逐字跳动。
  function readBreath(dt: number) {
    const speaking = mode === 'listening' || mode === 'answering'
    const targetEnergy = speaking ? level : mode === 'busy' ? 0.18 : 0
    breathEnergy += (targetEnergy - breathEnergy) * (1 - Math.exp(-dt * 2))

    const ampTarget = (mode === 'idle' ? 0.032 : 0.034) + breathEnergy * 0.04
    const rateTarget = (mode === 'idle' ? 0.74 : 0.8) + breathEnergy * 0.8
    breathAmp += (ampTarget - breathAmp) * (1 - Math.exp(-dt * 1.4))
    breathRate += (rateTarget - breathRate) * (1 - Math.exp(-dt * 0.85))

    breathPhase = (breathPhase + dt * breathRate) % TAU
    return 1 + breathEnergy * 0.018 + breathAmp * Math.sin(breathPhase)
  }

  function drawAmbient(ctx: CanvasRenderingContext2D) {
    const { width, height } = layout
    if (haloGradient) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.45 + activity * 0.55
      ctx.fillStyle = haloGradient
      ctx.fillRect(0, 0, width, height)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }
  }

  function drawBeams(ctx: CanvasRenderingContext2D) {
    const { width, groundY, height } = layout
    if (width < 560) return
    const strength = Math.min(1, width / 1100)
    ctx.globalCompositeOperation = 'lighter'
    for (const beam of BEAMS) {
      const shimmer = 0.55 + Math.sin(time * 0.7 + beam.phase) * 0.25 + Math.sin(time * 1.9 + beam.phase * 2) * 0.1
      const beamHeight = height * (beam.height + 0.12)
      ctx.globalAlpha = (0.2 + activity * 0.34) * shimmer * strength
      const beamWidth = Math.max(3, width * beam.width * 0.3)
      ctx.drawImage(beamSprite, width * beam.at - beamWidth / 2, groundY - beamHeight + 12, beamWidth, beamHeight)
      const dotSize = 10 + shimmer * 12
      ctx.globalAlpha = (0.4 + activity * 0.4) * shimmer
      ctx.drawImage(cyanSprite, width * beam.at - dotSize / 2, groundY - dotSize / 2, dotSize, dotSize)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawGroundGlow(ctx: CanvasRenderingContext2D) {
    const { centerX, groundY, width } = layout
    if (!groundGradient) return
    ctx.save()
    ctx.translate(centerX, groundY)
    ctx.scale(1, 0.24)
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = 0.34 + activity * 0.4
    ctx.fillStyle = groundGradient
    const radius = width * 0.5
    ctx.beginPath()
    ctx.arc(0, 0, radius, 0, TAU)
    ctx.fill()
    ctx.restore()
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawDust(ctx: CanvasRenderingContext2D, items: Dust[], strength: number, foreground: boolean) {
    const { width, height } = layout
    ctx.globalCompositeOperation = 'lighter'
    for (const item of items) {
      const twinkle = 0.55 + Math.sin(time * 1.6 + item.phase) * 0.45
      const alpha = (foreground ? 0.16 : 0.1 + item.depth * 0.4) * strength * twinkle
      if (alpha <= 0.01) continue
      const x = item.x * width
      const y = item.y * height
      const size = item.size * (foreground ? 10 : 5 + item.depth * 6)
      ctx.globalAlpha = alpha
      ctx.drawImage(item.tint > 0.6 ? brightSprite : cyanSprite, x - size / 2, y - size / 2, size, size)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawWave(ctx: CanvasRenderingContext2D) {
    const { width, centerX, centerY, orbRadius } = layout
    const energy = clamp01((activity - 0.07) * 1.6)
    if (energy < 0.015) return
    const extent = Math.min(width * 0.64, orbRadius * 6.5)
    const amplitude = orbRadius * (0.38 + energy * 0.42)
    const unit = Math.min(1.2, orbRadius / 110)
    const step = 3
    const brightness = Math.sqrt(energy)
    const noise = (seed: number) => {
      const value = Math.sin(seed) * 43758.5453
      return value - Math.floor(value)
    }
    const waveAt = (nx: number, clock: number) =>
      Math.sin(nx * 10.5 - clock * 0.8) * 0.78 +
      Math.sin(nx * 5.3 + clock * 0.28) * 0.16
    const spine: [number, number][] = []
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    // One continuous particle sheet with a luminous ridge, not two opposing strands.
    for (let x = Math.max(0, centerX - extent); x < Math.min(width, centerX + extent); x += step) {
      const nx = (x - centerX) / extent
      const edge = Math.pow(Math.max(0, 1 - nx * nx), 0.65)
      const shoulder = 0.3 + 0.7 * Math.sin(Math.min(1, Math.abs(nx) * 1.7) * Math.PI / 2)
      const envelope = amplitude * edge * shoulder
      const y = centerY + waveAt(nx, wavePhase) * envelope
      const centerFade = 0.02 + 0.98 * clamp01((Math.abs(x - centerX) - orbRadius * 0.65) / (orbRadius * 0.7))
      const alpha = brightness * edge * centerFade
      spine.push([x, y])
      const fold = 0.5 + 0.5 * Math.sin(nx * 13 - wavePhase * 0.55)
      const coreWidth = (3 + fold * 5 + energy * 2) * unit
      // Randomly distributed core dots avoid the evenly spaced rows of a rope.
      for (let point = 0; point < 5; point += 1) {
        const seed = x * 127.1 + point * 311.7
        const jitter = noise(seed)
        const cross = (noise(seed + 19.3) + noise(seed + 53.1) - 1) * coreWidth
        ctx.fillStyle = `rgba(20, 252, 235, ${alpha * (0.8 + jitter * 0.2)})`
        ctx.beginPath()
        ctx.arc(x + (jitter - 0.5) * step, y + cross, (0.65 + jitter * 0.65) * Math.max(0.85, unit), 0, TAU)
        ctx.fill()
      }
      // A continuous depth coordinate bends the surrounding sheet around the ridge.
      // Distant dots lag and drift more, and fade gradually rather than forming a second edge.
      for (let point = 0; point < 10; point += 1) {
        const seed = x * 91.7 + point * 173.3
        const jitter = noise(seed)
        const depth = (point + jitter) / 10 * 2 - 1
        const distance = Math.abs(depth)
        if (distance > 0.8 && noise(seed + 29) < 0.4) continue
        const phaseLag = depth * (0.7 + fold * 0.5)
        const sheetY = centerY + waveAt(nx, wavePhase - phaseLag) * envelope
        const spread = depth * orbRadius * (0.38 + energy * 0.2) * (0.55 + fold * 0.6)
        const drift = Math.sin(wavePhase * (0.3 + jitter * 0.2) + jitter * TAU)
        const px = x + (noise(seed + 41.2) - 0.5) * 9 + drift * distance * 11 * unit
        const py = sheetY + spread + Math.cos(wavePhase * 0.5 + jitter * TAU) * distance * 6 * unit
        const density = Math.exp(-distance * distance * 1.2)
        ctx.fillStyle = `rgba(18, 230, 229, ${alpha * density * (0.6 + jitter * 0.25)})`
        ctx.beginPath()
        ctx.arc(px, py, (0.6 + jitter * 0.75) * Math.max(0.8, unit), 0, TAU)
        ctx.fill()
      }
    }
    ctx.beginPath()
    spine.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y))
    const fade = ctx.createLinearGradient(centerX - extent, 0, centerX + extent, 0)
    fade.addColorStop(0, 'rgba(12, 244, 225, 0)')
    fade.addColorStop(0.25, `rgba(24, 255, 232, ${brightness * 0.7})`)
    fade.addColorStop(0.5 - orbRadius * 0.85 / (extent * 2), 'rgba(24, 255, 232, 0)')
    fade.addColorStop(0.5 + orbRadius * 0.85 / (extent * 2), 'rgba(24, 255, 232, 0)')
    fade.addColorStop(0.75, `rgba(24, 255, 232, ${brightness * 0.7})`)
    fade.addColorStop(1, 'rgba(12, 244, 225, 0)')
    ctx.strokeStyle = fade
    ctx.lineWidth = 1.2 * unit
    ctx.stroke()
    ctx.globalAlpha = 0.12
    ctx.lineWidth = 8 * unit
    ctx.stroke()
    ctx.restore()
  }

  function drawOrbRings(ctx: CanvasRenderingContext2D) {
    const { centerX, centerY } = layout
    ctx.globalCompositeOperation = 'lighter'
    for (const ring of rings) {
      const progress = clamp01((ring.radius - layout.orbRadius * 1.02) / (layout.orbRadius * 1.3))
      const alpha = ring.alpha * (1 - progress)
      if (alpha <= 0.005) continue
      ctx.strokeStyle = `rgba(126, 246, 255, ${alpha})`
      ctx.lineWidth = 1.1
      ctx.beginPath()
      ctx.arc(centerX, centerY, ring.radius, ring.start, ring.start + ring.span)
      ctx.stroke()
      if (ring.span < TAU) {
        ctx.strokeStyle = `rgba(228, 255, 255, ${alpha * 0.8})`
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.arc(centerX, centerY, ring.radius, ring.start + ring.span - 0.22, ring.start + ring.span)
        ctx.stroke()
      }
    }
    if (flash > 0.01) {
      const radius = layout.orbRadius * (1.06 + (1 - flash) * 0.55)
      ctx.strokeStyle = `rgba(205, 255, 255, ${flash * 0.5})`
      ctx.lineWidth = 1.6 + flash * 2
      ctx.beginPath()
      ctx.arc(centerX, centerY, radius, 0, TAU)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawRipples(ctx: CanvasRenderingContext2D) {
    const { centerX, groundY, orbRadius } = layout
    const maxRadius = orbRadius * 3.1
    ctx.globalCompositeOperation = 'lighter'
    for (const ripple of ripples) {
      const alpha = ripple.alpha * clamp01(1 - ripple.rx / maxRadius)
      if (alpha <= 0.005) continue
      ctx.strokeStyle = `rgba(110, 242, 255, ${alpha})`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.ellipse(centerX, groundY, ripple.rx, ripple.rx * 0.2, 0, 0, TAU)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawParticles(ctx: CanvasRenderingContext2D, items: Particle[]) {
    ctx.globalCompositeOperation = 'lighter'
    for (const particle of items) {
      const ratio = clamp01(particle.life / particle.maxLife)
      const alpha = Math.sin(ratio * Math.PI) * 0.85
      if (alpha <= 0.01) continue
      const size = particle.size * (2.5 + (1 - ratio) * 4)
      ctx.globalAlpha = alpha
      ctx.drawImage(particle.tint > 0.55 ? brightSprite : cyanSprite, particle.x - size / 2, particle.y - size / 2, size, size)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  function update(dt: number) {
    time += dt
    readLevel(dt)
    // Integrate speed so volume changes accelerate the ribbon without jumping its phase.
    wavePhase += dt * (0.5 + level * 2.8)
    accentCooldown = Math.max(0, accentCooldown - dt)
    if (mode !== 'idle' && level > 0.46 && level - previousLevel > 0.025 && accentCooldown === 0) {
      spawnBurst(0.15 + level * 0.3)
      // Accent particles are delicate; reserve the bright flash for explicit interaction.
      flash = Math.min(flash, 0.18)
      accentCooldown = 0.85
    }
    previousLevel = level
    onLevel(level, readBreath(dt))
    flash = Math.max(0, flash - dt * 2.4)

    for (const item of dust) {
      item.y -= item.speed * dt * (0.5 + activity * 1.5)
      item.x += Math.sin(time * 0.24 + item.phase) * dt * 0.004
      if (item.y < -0.04) {
        item.y = 1.04
        item.x = Math.random()
      }
      if (item.x < -0.02) item.x = 1.02
      if (item.x > 1.02) item.x = -0.02
    }
    for (const item of frontDust) {
      item.y -= item.speed * dt * (0.4 + activity)
      item.x += Math.sin(time * 0.18 + item.phase) * dt * 0.003
      if (item.y < -0.04) item.y = 1.04
      if (item.y > 1.04) item.y = -0.04
    }

    const ringRate =
      activity < 0.15 ? 3.8 : mode === 'busy' ? 1.8 : Math.max(0.38, 1.2 - level * 0.8)
    ringTimer -= dt
    if (ringTimer <= 0) {
      ringTimer = ringRate * rand(0.75, 1.2)
      rings.push({
        radius: layout.orbRadius * 1.02,
        alpha: mode === 'idle' ? 0.16 : 0.26 + level * 0.22,
        speed: (54 + level * 150) * rand(0.85, 1.15),
        start: rand(0, TAU),
        span: Math.random() > 0.35 ? TAU : rand(0.9, 2.1),
      })
    }
    rings = rings.filter((ring) => {
      ring.radius += ring.speed * dt
      return ring.radius < layout.orbRadius * 2.34
    })

    const rippleRate = mode === 'idle' ? 2.6 : Math.max(0.4, 1.15 - activity * 0.5)
    rippleTimer -= dt
    if (rippleTimer <= 0) {
      rippleTimer = rippleRate * rand(0.8, 1.2)
      ripples.push({ rx: layout.orbRadius * 1.02, alpha: mode === 'idle' ? 0.16 : 0.26 + activity * 0.28, speed: 16 + activity * 22 })
    }
    ripples = ripples.filter((ripple) => {
      ripple.rx += ripple.speed * dt * 6
      return ripple.rx < layout.orbRadius * 3.1
    })

    if (activity > 0.16) {
      sparkBudget += dt * (10 + level * 46)
      while (sparkBudget >= 1) {
        sparkBudget -= 1
        spawnSpark()
      }
    }
    for (const particle of [...sparks, ...bursts]) {
      particle.x += particle.vx * dt
      particle.y += particle.vy * dt
      particle.vx *= 1 - dt * 0.9
      particle.vy *= 1 - dt * 0.9
      particle.life -= dt
    }
    sparks = sparks.filter((particle) => particle.life > 0)
    bursts = bursts.filter((particle) => particle.life > 0)
  }

  function render() {
    const { width, height } = layout
    back.clearRect(0, 0, width, height)
    front.clearRect(0, 0, width, height)

    drawAmbient(back)
    drawBeams(back)
    drawGroundGlow(back)
    drawDust(back, dust, 0.5 + activity * 0.65, false)
    drawWave(back)
    drawOrbRings(back)
    drawRipples(back)

    drawDust(front, frontDust, 0.35 + activity * 0.45, true)
    drawParticles(front, sparks)
    drawParticles(front, bursts)
  }

  function frame(now: number) {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000))
    last = now
    update(dt)
    render()
    if (!document.hidden && !reducedMotion) raf = requestAnimationFrame(frame)
  }

  function applyCanvasSize(canvas: HTMLCanvasElement, width: number, height: number) {
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
  }

  function rebuildGradients() {
    const { centerX, centerY, orbRadius, width } = layout
    haloGradient = back.createRadialGradient(centerX, centerY, orbRadius * 0.3, centerX, centerY, orbRadius * 1.9)
    haloGradient.addColorStop(0, 'rgba(104, 246, 255, 0.17)')
    haloGradient.addColorStop(0.5, 'rgba(58, 218, 240, 0.06)')
    haloGradient.addColorStop(1, 'rgba(18, 130, 154, 0)')
    groundGradient = back.createRadialGradient(0, 0, 0, 0, 0, width * 0.5)
    groundGradient.addColorStop(0, 'rgba(120, 248, 255, 0.36)')
    groundGradient.addColorStop(0.5, 'rgba(44, 205, 228, 0.16)')
    groundGradient.addColorStop(1, 'rgba(20, 130, 150, 0)')
  }

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  function resume() {
    cancelAnimationFrame(raf)
    if (!document.hidden && !reducedMotion) {
      last = performance.now()
      raf = requestAnimationFrame(frame)
    } else if (reducedMotion) {
      render()
    }
  }
  function motionChanged() {
    reducedMotion = motionQuery.matches
    resume()
  }
  document.addEventListener('visibilitychange', resume)
  motionQuery.addEventListener('change', motionChanged)

  if (!reducedMotion) {
    last = performance.now()
    raf = requestAnimationFrame(frame)
  } else {
    onLevel(0.05, 1)
  }

  return {
    resize(next) {
      layout = next
      dpr = Math.min(2, window.devicePixelRatio || 1)
      for (const canvas of [backCanvas, frontCanvas]) {
        applyCanvasSize(canvas, next.width, next.height)
        const ctx = canvas.getContext('2d')
        ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      rebuildGradients()
      if (reducedMotion) {
        update(0.016)
        render()
      }
    },
    setMode(next) {
      if (next === mode) return
      const previous = mode
      mode = next
      if (previous === 'idle' && (next === 'listening' || next === 'answering')) spawnBurst(0.6)
      if (previous === 'listening' && next === 'answering') spawnBurst(0.35)
    },
    setAnalyser(next) {
      analyser = next
      waveData = next ? new Uint8Array(next.fftSize) : null
    },
    pulse() {
      spawnBurst(1)
    },
    destroy() {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', resume)
      motionQuery.removeEventListener('change', motionChanged)
    },
  }
}
