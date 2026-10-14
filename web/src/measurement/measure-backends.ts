import { Backend } from '../separation/backend'
import { MeasurementReply, MeasurementRequest, runProblem } from './measurement-messages'

type Candidate = MeasurementRequest['candidates'][number]

// The two steps of a measurement on one backend: separating the source, and
// timing the lyrics on the vocals with one candidate. Each step runs on the
// backend it is given, or throws.
export interface MeasurementSteps {
  separate(backend: Backend): Promise<{ vocals: Float32Array; separateMs: number; sumCheckDb: number }>
  measure(
    candidate: Candidate,
    backend: Backend,
    vocals: Float32Array,
  ): Promise<{ loadMs: number; alignMs: number; medianMs: number; p90Ms: number; within100Ms: number }>
}

// Measures every candidate on each backend in turn
// (docs/reference/models.md#measurement-method). Each backend separates the
// source once, and its candidates run on its own vocals. A separation that
// fails marks every candidate on that backend as not run, with its reason. A
// candidate that fails is a finding too. Either way the next one still runs.
export async function measureBackends(
  backends: readonly Backend[],
  candidates: MeasurementRequest['candidates'],
  steps: MeasurementSteps,
  reply: (reply: MeasurementReply) => void,
): Promise<void> {
  for (const backend of backends) {
    reply({ type: 'stage', stage: 'separate', backend })
    let vocals: Float32Array
    try {
      const separated = await steps.separate(backend)
      vocals = separated.vocals
      reply({ type: 'separated', backend, separateMs: separated.separateMs, sumCheckDb: separated.sumCheckDb })
    } catch (error) {
      // Read once, since reading frees a core fault.
      const problem = runProblem(error)
      for (const { candidate } of candidates) {
        reply({ type: 'candidate-failed', candidate, backend, ran: false, problem })
      }
      continue
    }
    for (const entry of candidates) {
      const { candidate } = entry
      reply({ type: 'stage', stage: 'align', backend, candidate })
      try {
        const figures = await steps.measure(entry, backend, vocals)
        reply({ type: 'measured', candidate, backend, ...figures })
      } catch (error) {
        reply({ type: 'candidate-failed', candidate, backend, ran: true, problem: runProblem(error) })
      }
    }
  }
}
