'use strict';

const logger = require('../utils/logger');
const { DAOVote, DAOProposal } = require('../models');
const { sequelize } = require('../database/connection');

class VoterReputationService {
  /**
   * Calculate the Governance Score for a specific wallet address.
   * Score is based on historical accuracy: (Correct Yes Votes + Correct No Votes) / Total Completed Votes
   * @param {string} walletAddress
   * @returns {Promise<number>} Governance Score (ratio between 0 and 1, plus a base weight)
   */
  async calculateGovernanceScore(walletAddress) {
    try {
      const votes = await DAOVote.findAll({
        where: { voter_address: walletAddress },
        include: [{
          model: DAOProposal,
          as: 'proposal',
          where: { status: 'completed' } // Only count completed projects
        }]
      });

      if (votes.length === 0) {
        return 1.0; // Base score for new members
      }

      let correctVotes = 0;
      for (const vote of votes) {
        const proposal = vote.proposal;
        // A vote is correct if voter said Yes and project succeeded, or voter said No and project failed.
        if (vote.vote_outcome === true && proposal.outcome_success === true) {
          correctVotes++;
        } else if (vote.vote_outcome === false && proposal.outcome_success === false) {
          correctVotes++;
        }
      }

      const totalVotes = votes.length;
      const accuracy = correctVotes / totalVotes;

      // Governance Score formula: Base (1.0) + Accuracy Bonus (0.0 to 1.0)
      // This allows users to double their voting weight if they have 100% accuracy.
      return 1.0 + accuracy;
    } catch (error) {
      logger.error(`Error calculating governance score for ${walletAddress}:`, error);
      return 1.0; // Fallback to base score
    }
  }

  /**
   * Get weights for a batch of wallet addresses.
   * Useful for the voting contract to fetch weights before a proposal starts.
   */
  async getBatchGovernanceScores(walletAddresses) {
    const scores = {};
    for (const address of walletAddresses) {
      scores[address] = await this.calculateGovernanceScore(address);
    }
    return scores;
  }

  /**
   * Mark a project as completed with a specific outcome.
   * This triggers the recalculation of reputation scores when queried next.
   */
  async updateProjectOutcome(proposalId, isSuccess) {
    const proposal = await DAOProposal.findByPk(proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);

    await proposal.update({
      status: 'completed',
      outcome_success: isSuccess
    });

    return { success: true, proposalId, isSuccess };
  }
}

module.exports = new VoterReputationService();
