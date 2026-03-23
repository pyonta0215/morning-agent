import { Agent, AgentInput, AgentOutput } from '../agents/base.js';

export class Pipeline {
  private collectors: Agent[] = [];
  private composers: Agent[] = [];

  register(agent: Agent, phase: 'collect' | 'compose'): void {
    if (phase === 'collect') {
      this.collectors.push(agent);
    } else {
      this.composers.push(agent);
    }
  }

  unregister(agentId: string): void {
    this.collectors = this.collectors.filter((a) => a.id !== agentId);
    this.composers = this.composers.filter((a) => a.id !== agentId);
  }

  async run(input: AgentInput): Promise<AgentOutput[]> {
    // 収集層: 並列実行
    console.log(`[Pipeline] collect phase start (${this.collectors.length} agents)`);
    const settledResults = await Promise.allSettled(
      this.collectors.map((agent) => {
        console.log(`[Pipeline] starting agent: ${agent.id}`);
        return agent.run(input);
      })
    );

    const collectResults: AgentOutput[] = settledResults.map((result, i) => {
      const agent = this.collectors[i];
      if (result.status === 'fulfilled') {
        console.log(`[Pipeline] agent ${agent.id} succeeded`);
        return result.value;
      } else {
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.log(`[Pipeline] agent ${agent.id} failed: ${error}`);
        return {
          agentId: agent.id,
          data: null,
          tokensUsed: 0,
          durationMs: 0,
          error,
        } satisfies AgentOutput;
      }
    });

    const successCount = collectResults.filter((r) => !r.error).length;
    if (successCount === 0) {
      throw new Error('[Pipeline] All collectors failed. Aborting pipeline.');
    }

    console.log(`[Pipeline] collect phase done (${successCount}/${this.collectors.length} succeeded)`);

    // 統合層: 直列実行
    console.log(`[Pipeline] compose phase start (${this.composers.length} agents)`);
    const allResults: AgentOutput[] = [...collectResults];

    for (const composer of this.composers) {
      console.log(`[Pipeline] starting composer: ${composer.id}`);
      const composeInput: AgentInput = {
        ...input,
        context: allResults,
      };
      const result = await composer.run(composeInput);
      console.log(`[Pipeline] composer ${composer.id} done`);
      allResults.push(result);
    }

    console.log('[Pipeline] all phases complete');
    return allResults;
  }
}
