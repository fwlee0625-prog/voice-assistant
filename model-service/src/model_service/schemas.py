"""Bounded, business-independent decision requests."""

import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Text = Annotated[str, Field(min_length=1, max_length=600)]


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["choice", "noul", "score"]
    instructions: Text
    criteria: dict[Text, Text] | list[Text] | None = None

    @model_validator(mode="after")
    def validate_criteria(self):
        if self.type == "choice" and not (
            isinstance(self.criteria, dict) and 2 <= len(self.criteria) <= 8
        ):
            raise ValueError("choice requires 2–8 described options")
        if self.type == "score" and not (
            isinstance(self.criteria, list) and 2 <= len(self.criteria) <= 8
        ):
            raise ValueError("score requires 2–8 ordered levels")
        if self.type == "noul" and self.criteria is not None:
            raise ValueError("noul does not accept criteria")
        return self


class DecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: Annotated[str, Field(min_length=1, max_length=100)] = "laya-multilingual"
    state: Annotated[str, Field(min_length=1, max_length=4000)] | dict
    questions: Annotated[dict[Text, Question], Field(min_length=1, max_length=4)]

    @field_validator("state")
    @classmethod
    def bound_state(cls, value):
        if len(json.dumps(value, ensure_ascii=False)) > 4000:
            raise ValueError("state exceeds 4000 characters")
        return value
